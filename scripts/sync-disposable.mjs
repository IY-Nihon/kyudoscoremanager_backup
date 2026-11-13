/**
 * 使い捨てメールのドメインの一覧（Firestore の disposable_domains/{ドメイン}）に、増えたぶんだけ足す。
 * 週 1 回、GitHub Actions（.github/workflows/disposable.yml）が動かす（2026-11-13）。
 *
 * ■ 何を足すか（自分では判断しない）
 *   disposable-email-domains（https://github.com/disposable-email-domains/disposable-email-domains。CC0）の
 *   disposable_email_blocklist.conf。人が報告して人が確かめてから載せる一覧で、ふつうに使われているドメインは外してある。
 *   機械が自動で集めた大きい一覧（10 万件）は、携帯会社やプロバイダーのふつうのドメインが混じるので使わない。
 *
 * ■ 守り（向こうの一覧が壊れても、ふつうの人を締め出さない）
 *   ・足すだけ。消さない・書き換えない
 *   ・守るドメイン（下の 守る・守る末尾）は、一覧に載っていても足さない
 *   ・一覧が小さすぎる（5,000 件未満）・1 回に増える数が多すぎる（2,000 件超）ときは、何も書かずに失敗で終わる
 *   ・DRY_RUN=1 なら数えるだけ
 *
 * ログにはドメインの名前と数だけを出す（団体・人の情報には触れない）。
 * 手元で初めに入れる・手元の一覧（アプリの src/suteMail.js）を入れるのは、アプリの倉庫の scripts/sync-disposable-domains.mjs。
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const 出どころ =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';
const 一覧の下限 = 5000;
const 一回に足す上限 = 2000;
const 数えるだけ = process.env.DRY_RUN === '1';
const ドメインの形 = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 載っていても足さないドメイン（ふつうの人が使う） */
const 守る = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'ymail.ne.jp', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com',
  'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'hotmail.jp', 'live.jp', 'live.com', 'msn.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'ymobile.ne.jp', 'y-mobile.ne.jp',
  'rakuten.jp', 'rakumail.jp', 'uqmobile.jp', 'nifty.com', 'biglobe.ne.jp', 'ocn.ne.jp', 'so-net.ne.jp',
  'plala.or.jp', 'odn.ne.jp', 'odn.ad.jp', 'jcom.home.ne.jp', 'jcom.zaq.ne.jp', 'eonet.ne.jp', 'aol.com',
  'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'mail.com',
]);
/** この末尾のドメインは足さない（学校・役所・日本のプロバイダー） */
const 守る末尾 = ['.ac.jp', '.ed.jp', '.go.jp', '.lg.jp', '.edu', '.ne.jp', '.or.jp', '.ad.jp'];
const 守るか = (d) => 守る.has(d) || 守る末尾.some((末尾) => d.endsWith(末尾));

function 止まる(文) {
  console.error(`::error::${文}`);
  process.exit(1);
}

const 鍵 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!鍵) 止まる('FIREBASE_SERVICE_ACCOUNT_JSON が設定されていません');
let 口座;
try {
  口座 = JSON.parse(鍵);
} catch {
  止まる('FIREBASE_SERVICE_ACCOUNT_JSON を読めませんでした');
}
initializeApp({ credential: cert(口座) });
const db = getFirestore();

const 返り = await fetch(出どころ);
if (!返り.ok) 止まる(`一覧を取れませんでした（${返り.status}）`);
const 外 = [
  ...new Set(
    (await 返り.text())
      .split(/\r?\n/)
      .map((行) => 行.trim().toLowerCase())
      .filter((行) => 行 && !行.startsWith('#') && ドメインの形.test(行))
  ),
];
if (外.length < 一覧の下限) 止まる(`一覧が小さすぎます（${外.length} 件）。向こうの一覧が壊れているかもしれないので、何も書きません`);

const 守った = 外.filter(守るか);
const ある = new Set((await db.collection('disposable_domains').listDocuments()).map((文書) => 文書.id));
const 足す = 外.filter((d) => !ある.has(d) && !守るか(d)).sort();
console.log(`向こうの一覧 ${外.length} 件・いま入っている ${ある.size} 件・足すもの ${足す.length} 件`);
if (守った.length) console.log(`守るドメインに当たったので足さない: ${守った.join(', ')}`);
if (足す.length > 一回に足す上限)
  止まる(`増える数が多すぎます（${足す.length} 件）。向こうの一覧を目で確かめてから、手で入れてください。何も書きません`);
if (!足す.length) {
  console.log('増えたものはありません。');
  process.exit(0);
}
console.log(`足すもの: ${足す.join(', ')}`);
if (数えるだけ) {
  console.log('数えるだけ（DRY_RUN=1）なので、書きません。');
  process.exit(0);
}

const 今 = Timestamp.now();
let 入れた = 0;
for (let 番 = 0; 番 < 足す.length; 番 += 400) {
  const 束 = db.batch();
  // 無いものだけを選んである。もし同時に入っていても、同じ形の中身を重ねるだけ
  for (const d of 足す.slice(番, 番 + 400))
    束.set(db.collection('disposable_domains').doc(d), { 出どころ: 'disposable-email-domains', 入れた日: 今 }, { merge: true });
  await 束.commit();
  入れた += Math.min(400, 足す.length - 番);
}
console.log(`入れた: ${入れた} 件`);
