# GitHub Actions 臨時雲端掃描包

狀態：僅備妥程式，**尚未上傳、尚未登入、尚未掃描或寄信**。請只建立私人儲存庫；本資料夾以外的 SSH 私鑰、報告、設定檔不得上傳。

## 使用前驗證

1. 本機掃描器的專用 Chrome 必須已登入 TradingView，而且圖表可看到私人 `tTMA ST 1.0.000` 指標。
2. 在本機 `ttma-scanner` 資料夾執行 `node cloud/export-session.mjs`。它只在你的終端機顯示一長串登入憑證；**不要貼到聊天、郵件或程式碼中**，並當作密碼保管。此憑證可能過期或被 TradingView 要求重新登入。
3. 建立 GitHub 私人儲存庫，**只上傳本 `github-deploy` 資料夾內容**。在儲存庫的 Actions secrets 設定 `TV_SESSION_COOKIES_B64`。不要放在 Variables。
4. Actions 手動執行 `TradingView L1 and S Alpha scan`，先選 `test`。它只掃前五檔，不寄信。核對執行紀錄及短期保存的報表中的代號、`DataDate` 與原始指標值。
5. 測試成功後，若要寄信，再設定 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS` 四個 Actions secrets。寄件服務的應用程式密碼同樣不得提供給聊天或放進程式碼。手動選 `full` 測完 997 檔及收信後，才能考慮新增每日排程。

排程已預設為台灣時間**週一至週五 14:17**，但 `ENABLE_WEEKDAY_SCAN` 未設成 `true` 前會跳過，不會正式掃描。五檔、全量、寄信測試通過，且 GitHub Actions 帳務設定「達預算即停止使用」並確認不會產生費用後，才能設定此 Actions variable 啟用。完整掃描在本機曾需約 101 分鐘；GitHub Free 私人儲存庫每月 2,000 分鐘，若整月約 22 個平日都掃描，預估 2,222 分鐘，超過免費額度。達到免費上限後應停止執行，不能同時保證「整月每個平日都有報告」與「絕不付費」。

原始清單是使用者圈選的 `20260709` 固定 1000 檔，而不是每日重新排序的成交值排行；固定排除 `TPEX:5371`、`TWSE:2867`、`TPEX:5236`，因此完整掃描為 997 檔。掃描需能讀取 TradingView 私人指標；從本機複製的登入憑證若失效，雲端也會失敗。即使掃描成功，舊 `DataDate` 的訊號不會列為今日訊號；失敗股票會在信中標示為結果未齊。
