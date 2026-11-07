// scripts/verify-exact.mjs
// バックアップ直後に、Firestore・RTDB・Auth の実データと控えを1文字単位で照合するスクリプト
// backup.yml の中でバックアップ実行直後に呼ばれる
// ログは Actions に残る（2026-11 から動かすのは非公開の倉庫だが、念のため）。団体ID・団体名・文書の ID・中身の値・メールアドレス・uid・
// RTDB の枝（団体の合言葉）は出さない。どこが違ったかは、集まりの道の型（groups/*/sessions）・数・項目の名前・何番目の団体かで出す
//
// ■ どこまで照合するか（無料の枠：Firestore の読みは 1 日 5 万回。アプリ・控えと分け合う）
// 控えにある集まりは全部たどる（前は group_accounts と groups の下の 1 段だけで、団体の文書そのもの・所属の証・
// 団体の持ち主だけの文書（group_accounts/*/private）・ほかの根の集まりは見ていなかった）。
//   ・中身まで: 下の「数だけ」のほかの全部。集まりごとに 1 回の問い合わせで読む（1 件 1 回の読み。前は一覧と中身で 2 回）
//   ・数だけ: 消した団体の 30 日の控え（deleted_accounts）・不具合の便り（errorReports）・回数の控え（rate_limits）。
//     数え上げで件数だけ比べる（1,000 件で 1 回の読み）
//   ・控えに無い集まり（控えたあとにできたもの・控えが取りこぼしたもの）は、根と、下に集まりを持つ文書ごとに 1 回ずつ聞いて見つける
// 読んだ数をログの終わりに出す

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp, DocumentReference, GeoPoint } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { readFileSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { resolve } from 'path';

// ─────────────────────────────────────────
// 環境変数チェック・JSON.parse を try-catch で保護
// ─────────────────────────────────────────

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON が未設定です。');
  process.exit(1);
}

let firebaseServiceAccount;
try {
  firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON が不正なJSONです。');
  process.exit(1);
}

// ─────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────

let app, db, auth, rtdb;
try {
  app = initializeApp({
    credential: cert(firebaseServiceAccount),
    databaseURL: 'https://kyudoscoremanager-default-rtdb.firebaseio.com',
  });
  db = getFirestore();
  auth = getAuth();
  rtdb = getDatabase(app);
} catch {
  console.error('❌ Firebase初期化に失敗しました。FIREBASE_SERVICE_ACCOUNT_JSONを確認してください。');
  process.exit(1);
}

const 同時の上限 = 8; // 同時に走らせる問い合わせの数

/** 数だけ比べる集まり（道の型） */
const 数だけの型 = [/^deleted_accounts(\/|$)/, /^errorReports$/, /^rate_limits$/];
const 数だけか = (型) => 数だけの型.some(形 => 形.test(型));

const 数 = { 読み: 0 };

// groups/abc/sessions → groups/*/sessions（文書の ID は出さない）
const 型の道 = (道) => 道.split('/').map((名, 番) => (番 % 2 ? '*' : 名)).join('/');

/** エラーの文から文書の道・RTDB の道（団体ID・ライブの枝が入る）を伏せる */
const 伏せる = (文) => String(文).replace(/documents\/[^\s'",)]+/g, 'documents/…').replace(/ at \/[^\s:'",)]+/g, ' at /…');

/** 同時に走らせる問い合わせの数を絞る。問い合わせ 1 本だけを包む（中で絞りを待つと詰まる） */
function 絞りを作る(上限) {
  let 走り = 0;
  const 列 = [];
  const 次へ = () => {
    while (走り < 上限 && 列.length) {
      const { 仕事, 済み, 失敗 } = 列.shift();
      走り++;
      Promise.resolve()
        .then(仕事)
        .then(済み, 失敗)
        .finally(() => {
          走り--;
          次へ();
        });
    }
  };
  return (仕事) => new Promise((済み, 失敗) => {
    列.push({ 仕事, 済み, 失敗 });
    次へ();
  });
}
const 絞って = 絞りを作る(同時の上限);

const 空か = (物) => !物 || Object.keys(物).length === 0;
const 字の順 = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// ─────────────────────────────────────────
// バックアップ読み込み
// ─────────────────────────────────────────

function loadBackup() {
  const dir = './backup-output';
  const files = readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort();
  if (files.length === 0) throw new Error('backup-output/ にファイルがありません');
  const latest = files.at(-1);
  console.log(`📂 照合対象: ${latest}`);
  return JSON.parse(gunzipSync(readFileSync(resolve(dir, latest))).toString('utf8'));
}

// ─────────────────────────────────────────
// 値の正規化（比較前に型を揃える）
// ─────────────────────────────────────────

// 日時は控えでは ISO 8601 の字。両側とも、日時の形の字はミリ秒の数にして比べる
// （前は控えの側だけを数にしていて、Firestore に日時の形の字があると毎回「違う」になった）
const 日時の字 = /^\d{4}-\d{2}-\d{2}T/;
function 字を整える(字) {
  if (!日時の字.test(字)) return 字;
  const ミリ秒 = new Date(字).getTime();
  return Number.isNaN(ミリ秒) ? 字 : ミリ秒;
}

const 並べる = (物, 整え) => Object.fromEntries(Object.entries(物).sort(字の順).map(([k, v]) => [k, 整え(v)]));
const ベクトルか = (値) => typeof 値?.toArray === 'function' && 値.constructor?.name === 'VectorValue';

/** 控えの値（JSON）を比べる形へ */
function normalizeBk(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return 字を整える(value);
  if (Array.isArray(value)) return value.map(normalizeBk);
  if (typeof value === 'object') return 並べる(value, normalizeBk);
  return value;
}

/** Firestore の値を比べる形へ。参照・位置・バイト列・ベクトルは、控えの形（scripts/backup-firestore.mjs の頭）にしてから */
function normalize(value) {
  if (value === null || value === undefined) return null;
  // 控えは toDate()（ミリ秒に丸める）で字にしている。toMillis() は切り捨てなので使わない
  if (value instanceof Timestamp) return value.toDate().getTime();
  if (value instanceof DocumentReference) return normalizeBk({ _ref: value.path });
  if (value instanceof GeoPoint) return normalizeBk({ _geo: [value.latitude, value.longitude] });
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return normalizeBk({ _bytes: Buffer.from(value).toString('base64') });
  if (ベクトルか(value)) return normalizeBk({ _vector: value.toArray() });
  if (typeof value === 'string') return 字を整える(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const 原型 = Object.getPrototypeOf(value);
    if (原型 !== Object.prototype && 原型 !== null) return normalizeBk({ _unknown: String(value) });
    return 並べる(value, normalize);
  }
  return value;
}

// ─────────────────────────────────────────
// 差分検出
// ─────────────────────────────────────────

/** 違う項目の名前を集める（値は集めない） */
function 違う項目(fbData, bkData) {
  const 出 = [];
  for (const key of new Set([...Object.keys(fbData || {}), ...Object.keys(bkData || {})])) {
    const fb = JSON.stringify(normalize(fbData?.[key]));
    const bk = JSON.stringify(normalizeBk(bkData?.[key]));
    if (fb !== bk) 出.push(key);
  }
  return 出;
}

/** 控えの文書が Firestore にあるはずか。古い形（format 1）には「中身が無く下に集まりだけ」の印が無い */
function 控えの有無(文書, 形) {
  if (文書._exists === false) return 'なし';
  if (形 < 2 && 空か(文書._fields) && !空か(文書._collections)) return '不明';
  return 'あり';
}

/** 控えの木から、集まりを全部（道と文書たち）並べる */
function 控えの集まりたち(集まりたち, 親 = '', 出 = []) {
  for (const [名, 文書たち] of Object.entries(集まりたち || {})) {
    const 道 = 親 ? `${親}/${名}` : 名;
    出.push({ 道, 文書たち: 文書たち || [] });
    for (const 文書 of 文書たち || []) 控えの集まりたち(文書._collections, `${道}/${文書.id}`, 出);
  }
  return 出;
}

// ─────────────────────────────────────────
// コレクション照合
// ─────────────────────────────────────────

const 型ごと = new Map();
function 型の結果(型, 方法) {
  if (!型ごと.has(型)) {
    型ごと.set(型, { 方法, か所: 0, 件数: 0, 控えに無い: 0, 控えに余分: 0, 違う文書: 0, 違う項目: new Set(), 場所: new Set() });
  }
  return 型ごと.get(型);
}

/** 中身まで比べる（集まりを 1 回の問い合わせで読む） */
async function 中身まで比べる({ 道, 文書たち }, 形, 場所) {
  const 結果 = 型の結果(型の道(道), '中身まで');
  const snap = await 絞って(() => db.collection(道).get());
  数.読み += Math.max(1, snap.size);

  const 控え = new Map();
  const 不明 = new Set();
  for (const 文書 of 文書たち) {
    const 有無 = 控えの有無(文書, 形);
    if (有無 === 'あり') 控え.set(文書.id, 文書._fields || {});
    else if (有無 === '不明') 不明.add(文書.id);
  }

  結果.か所++;
  結果.件数 += snap.size;
  let 違った = false;
  for (const d of snap.docs) {
    if (!控え.has(d.id)) {
      if (!不明.has(d.id)) {
        結果.控えに無い++;
        違った = true;
      }
      continue;
    }
    const 違い = 違う項目(d.data(), 控え.get(d.id));
    if (違い.length) {
      結果.違う文書++;
      違い.forEach(名 => 結果.違う項目.add(名));
      違った = true;
    }
  }
  const 雲にある = new Set(snap.docs.map(d => d.id));
  for (const id of 控え.keys()) {
    if (!雲にある.has(id)) {
      結果.控えに余分++;
      違った = true;
    }
  }
  if (違った && 場所(道)) 結果.場所.add(場所(道));
}

/** 数だけ比べる（数え上げ。1,000 件で 1 回の読み） */
async function 数を比べる({ 道, 文書たち }, 形, 場所) {
  const 結果 = 型の結果(型の道(道), '数だけ');
  const 件数 = (await 絞って(() => db.collection(道).count().get())).data().count;
  数.読み += Math.max(1, Math.ceil(件数 / 1000));
  const あり = 文書たち.filter(d => 控えの有無(d, 形) === 'あり').length;
  const 不明 = 文書たち.filter(d => 控えの有無(d, 形) === '不明').length;
  結果.か所++;
  結果.件数 += 件数;
  if (件数 > あり + 不明) 結果.控えに無い += 件数 - あり - 不明;
  else if (件数 < あり) 結果.控えに余分 += あり - 件数;
  else return;
  if (場所(道)) 結果.場所.add(場所(道));
}

/** 控えに無い集まりを探す（根と、控えで下に集まりを持つ文書ごとに 1 回ずつ聞く） */
async function 控えに無い集まりを探す(集まりたち, 控えない) {
  const 控えの道 = new Set(集まりたち.map(c => c.道));
  const 出 = new Set();
  const 根 = await db.listCollections();
  数.読み += 1;
  for (const c of 根) if (!控えの道.has(c.id) && !控えない.has(c.id)) 出.add(型の道(c.path));
  const 親たち = [];
  for (const { 道, 文書たち } of 集まりたち) {
    for (const 文書 of 文書たち) if (!空か(文書._collections)) 親たち.push(`${道}/${文書.id}`);
  }
  await Promise.all(親たち.map(async 親 => {
    const 下 = await 絞って(() => db.doc(親).listCollections());
    数.読み += 1;
    for (const c of 下) if (!控えの道.has(c.path)) 出.add(型の道(c.path));
  }));
  return [...出].sort();
}

async function Firestoreを照合する(backup) {
  const 形 = Number(backup.format) || 1;
  const bFirestore = backup.firestore || {};
  const 控えない = new Map(Object.entries(backup.skippedCollections || {}));
  // 古い形の控えには「控えなかった集まり」の記録が無い（その頃は全部を控えていた）

  // 何番目の団体か（根の集まりの中の順。控えを戻して探すときの手がかり。団体ID は出さない）
  const 上の番号 = new Map();
  for (const [名, 文書たち] of Object.entries(bFirestore)) {
    (文書たち || []).forEach((文書, 番) => 上の番号.set(`${名}/${文書.id}`, `${名} の ${番 + 1} 番目`));
  }
  const 場所 = (道) => {
    const 段 = 道.split('/');
    return 段.length >= 3 ? 上の番号.get(`${段[0]}/${段[1]}`) || null : null;
  };

  const 集まりたち = 控えの集まりたち(bFirestore);
  await Promise.all(集まりたち.map(集まり =>
    数だけか(型の道(集まり.道)) ? 数を比べる(集まり, 形, 場所) : 中身まで比べる(集まり, 形, 場所)
  ));
  const 無い集まり = await 控えに無い集まりを探す(集まりたち, 控えない);

  let errors = 0;
  for (const [型, 結] of [...型ごと].sort(字の順)) {
    const 所 = 結.か所 > 1 ? `（${結.か所} か所）` : '';
    const 方法 = 結.方法 === '数だけ' ? '・数だけ' : '';
    if (!結.控えに無い && !結.控えに余分 && !結.違う文書) {
      console.log(`  ✅ ${型}: ${結.件数}件 一致${方法}${所}`);
      continue;
    }
    errors++;
    const 内訳 = [
      結.違う文書 && `中身の違う文書 ${結.違う文書}件（項目: ${[...結.違う項目].slice(0, 10).join(', ')}）`,
      結.控えに無い && `控えに無い ${結.控えに無い}件`,
      結.控えに余分 && `控えにだけある ${結.控えに余分}件`,
    ].filter(Boolean).join('・');
    console.log(`  ❌ ${型}: ${内訳}${方法}${所}`);
    if (結.場所.size) {
      console.log(`     場所: ${[...結.場所].slice(0, 10).join('・')}${結.場所.size > 10 ? ` ほか ${結.場所.size - 10} か所` : ''}`);
    }
  }
  if (無い集まり.length) {
    errors++;
    console.log(`  ❌ 控えに無い集まり: ${無い集まり.join(', ')}（控えたあとにできた・控えが取りこぼした）`);
  }
  for (const [名, 中] of 控えない) console.log(`  ⏭  ${名}: 控えていない（${中?.count ?? '?'}件。${中?.reason ?? ''}）`);
  console.log(`  📖 照合の Firestore の読み: おおよそ ${数.読み.toLocaleString('ja-JP')}回（無料の枠は 1 日 5 万回。アプリ・控えと分け合う）`);
  return errors;
}

// ─────────────────────────────────────────
// メイン
// ─────────────────────────────────────────

async function main() {
  console.log('\n🔍 バックアップ完全照合を開始します\n');

  const backup = loadBackup();
  let totalErrors = 0;

  console.log('\n=== Firestore（集まりの道の型ごと）===');
  totalErrors += await Firestoreを照合する(backup);

  console.log('\n=== RTDB（全パス）===');
  const rtdbSnap = await rtdb.ref('/').once('value');
  const fbRtdb = rtdbSnap.val() || {};
  const bkRtdb = backup.rtdb || {};
  const fbRtdbJson = JSON.stringify(normalize(fbRtdb));
  const bkRtdbJson = JSON.stringify(normalizeBk(bkRtdb));
  if (fbRtdbJson === bkRtdbJson) {
    console.log(`  ✅ RTDB 全データ: 完全一致`);
  } else {
    console.log(`  ❌ RTDB: 差分あり`);
    // 根の下（live_sessions など）だけを名前で出す。その下の枝は団体の合言葉なので出さない
    for (const key of new Set([...Object.keys(fbRtdb), ...Object.keys(bkRtdb)])) {
      const fb = JSON.stringify(normalize(fbRtdb[key]));
      const bk = JSON.stringify(normalizeBk(bkRtdb[key]));
      if (fb !== bk) console.log(`     差分のある根: /${key}`);
    }
    totalErrors++;
  }

  console.log('\n=== Firebase Auth ===');
  const authUsers = [];
  let pageToken;
  do {
    const result = await auth.listUsers(1000, pageToken);
    authUsers.push(...result.users);
    pageToken = result.pageToken;
  } while (pageToken);

  const bkUsers = backup.auth?.users || [];
  const fbUidMap = Object.fromEntries(authUsers.map(u => [u.uid, u]));
  const bkUidMap = Object.fromEntries(bkUsers.map(u => [u.uid, u]));

  const missingUids = authUsers.map(u => u.uid).filter(uid => !bkUidMap[uid]);
  const extraUids = bkUsers.map(u => u.uid).filter(uid => !fbUidMap[uid]);
  let authDiffs = 0;

  if (missingUids.length || extraUids.length) {
    console.log(`  ❌ Auth: 件数不一致 Firebase=${authUsers.length} BK=${bkUsers.length}`);
    if (missingUids.length) console.log(`     BK未収録: ${missingUids.length} 人`);
    if (extraUids.length) console.log(`     BK余分:   ${extraUids.length} 人`);
    totalErrors++;
  } else {
    for (const fbUser of authUsers) {
      const bkUser = bkUidMap[fbUser.uid];
      if (!bkUser) continue;
      // uid とメールアドレスは出さない（数だけ）
      if (fbUser.email !== bkUser.email) authDiffs++;
      if (fbUser.metadata?.creationTime !== bkUser.createdAt) authDiffs++;
    }
    if (authDiffs > 0) {
      console.log(`  ❌ Auth: フィールド差分 ${authDiffs} 箇所`);
      totalErrors++;
    } else {
      console.log(`  ✅ Auth: ${authUsers.length}件 完全一致（uid・email・createdAt）`);
    }
  }

  console.log('\n' + '='.repeat(50));
  if (totalErrors === 0) {
    console.log('✅ 全データが完全に一致しています（1文字の差異もなし。「数だけ」の集まりは件数が一致）');
  } else {
    console.log(`❌ ${totalErrors} 件の問題が検出されました`);
    process.exitCode = 1;
  }

  await app.delete();
}

main().catch(async err => {
  console.error('\n❌ 照合スクリプトエラー:', err?.code ?? '', 伏せる(err?.message ?? err));
  await app.delete().catch(() => {});
  process.exit(1);
});
