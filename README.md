# kyudoscoremanager_backup

`kyudoscoremanager_app` の Firestore・RTDB・Firebase Auth データを毎日自動バックアップするリポジトリです。

## 仕組み

- 毎日深夜0時（JST）に GitHub Actions が自動実行
- Firebase Admin SDK で全データを取得
- gzip 圧縮したうえで **AES256 で暗号化**し、GitHub Artifacts に保存（90日間保持）
- バックアップ直後に Firestore と1文字単位で照合し、差異があれば通知

## セキュリティについて

このリポジトリは公開しています。**公開の場に本番データを素のまま置かない**ことを前提に組んでいます。

- Firebase への接続に必要な秘密鍵は GitHub Secrets で管理されており、コードには含まれていません
- 外部からの Pull Request ではワークフローが実行されません（Secrets 漏洩対策）
- ワークフローの権限は `contents: read` のみ
- **バックアップ本体は AES256 で暗号化してからアップロードします。**鍵は Secrets にあり、
  リポジトリにも成果物にも含まれません

### なぜ暗号化するか

GitHub の成果物は「リポジトリを読める人」がダウンロードできます。**公開リポジトリでは、それは
全世界のログイン済み利用者を指します**（このリポジトリの管理権限は要りません）。
2026-09-03 に、管理権限を持たない別アカウントから成果物の一覧・サイズ・ダウンロード導線が
見えることを実際に確かめました。

中身は本番の Firestore・RTDB・Firebase Auth で、部員の氏名と記録、利用者のメールアドレス
（Auth は uid・メール・作った日時・最後のログイン日時だけ。パスワードのハッシュは取っていません）を含みます。
だから素のままでは置けません。
暗号化すれば、誰でも落とせても**鍵が無ければ読めません**。

未ログインの状態ではダウンロードできない（HTTP 401）ことも確認していますが、
それだけを頼りにはしていません。

## 復元のしかた

1. Actions の実行結果ページから成果物（`backup-NN`）をダウンロードして展開する
2. 復号する（`BACKUP_ENCRYPTION_KEY` が要ります）

   ```bash
   gpg --batch --quiet --decrypt \
       --passphrase "$BACKUP_ENCRYPTION_KEY" \
       --output backup.json.gz \
       backup-2026-09-03_00-00-00.json.gz.gpg
   ```

3. 展開すると `{ exportedAt, projectId, firestore, rtdb, auth }` の形の JSON になります

   ```bash
   gunzip -c backup.json.gz | head -c 400
   ```

**鍵を失うと、どの控えも復元できません。**パスワード管理ツールなど、この
リポジトリとは別の場所に必ず控えてください。

## 必要な GitHub Secrets

| Secret名 | 内容 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin SDK のサービスアカウント鍵（JSON） |
| `BACKUP_ENCRYPTION_KEY` | バックアップを暗号化する合言葉。**設定しないとワークフローは止まります** |

`BACKUP_ENCRYPTION_KEY` を作って設定する例：

```bash
KEY=$(openssl rand -base64 48)
echo "$KEY"   # ← パスワード管理ツールへ控えてから消すこと
gh secret set BACKUP_ENCRYPTION_KEY --repo IY-Nihon/kyudoscoremanager_backup --body "$KEY"
```

鍵が設定されていないとき、ワークフローは**素のバックアップを上げずにその場で止まります**。
控えが1日できないことより、公開の場へ素で出すことのほうが重いと考えているためです。

## 保持期間について

公開リポジトリの成果物の保持期間は **90日が上限**です（設定画面にも明記されています）。
それ以上の日数をワークフローに書いても切り詰められます。
より長く持ちたい場合は、保存先を Artifacts 以外（非公開のストレージなど）へ移す必要があります。

## 2026-09-03 より前の成果物について

暗号化を入れる前の成果物が残っています。これらは**暗号化されていません**。
90日の保持期間が過ぎれば順に消えます。
