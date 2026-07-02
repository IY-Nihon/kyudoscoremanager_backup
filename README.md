# kyudoscoremanager_backup

`kyudoscoremanager_app` の Firestore・RTDB・Firebase Auth データを毎日自動バックアップするリポジトリです。

## 仕組み

- 毎日深夜0時（JST）に GitHub Actions が自動実行
- Firebase Admin SDK で全データを取得
- gzip 圧縮して GitHub Artifacts に保存（365日間保持）
- バックアップ直後に Firestore と1文字単位で照合し、差異があれば通知

## セキュリティについて

このリポジトリはパブリックですが、公開されているのは**コードのみ**です。

- Firebase への接続に必要な秘密鍵は GitHub Secrets で管理されており、コードには含まれていません
- バックアップファイル自体は GitHub Artifacts に保存され、非公開です（`.gitignore` でリポジトリには含まれません）
- 外部からの Pull Request ではワークフローが実行されない設定になっています（Secrets 漏洩対策）

## 必要な GitHub Secrets

| Secret名 | 内容 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin SDK のサービスアカウント鍵（JSON） |
