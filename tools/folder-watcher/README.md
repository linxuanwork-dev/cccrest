# CC CREST 文件夹小程序（Folder watcher）

放在办公室电脑上跑的一个小程序，做两件事：

1. **单据自动上传**：每家公司一个「收件」文件夹。把单据文件（PDF / JPG / PNG / WEBP）丢进去，小程序自动上传到系统，采购单页面的「收件箱」就会出现这个文件。上传成功后，文件会按系统给的名字（`公司简称-PURCHASE-2026_11-001.pdf`）改名，存进这家公司的「已上传」文件夹。
2. **导出文件自动归位**：从系统下载的 Bukku Excel（文件名以设定的前缀开头，例如 `WCCHMSB-`）会从「下载」文件夹自动搬进这家公司的「导出」文件夹。

不需要安装任何额外的东西，只要电脑上有 Node.js（18 或更新）。

## 第一次设置

1. **在系统里生成 token**：登录系统 → Control Panel →「自动读取文件夹」→ 选公司，写一个电脑名字（例如「办公室」）→「生成 token」。token **只显示一次**，请马上复制。每家公司、每台电脑各一个 token；token 只能上传到那一家公司，读不到任何资料。
2. 把 `config.example.json` 复制一份，改名 `config.json`，填好：
   - `server`：系统的网址（已经填好）；
   - `downloads`：浏览器下载文件的文件夹；
   - `companies`：每家公司一段 —— `token`（刚才复制的）、`inbox`（收件文件夹）、`done`（已上传文件夹）、`exports`（导出文件夹）、`exportPrefix`（导出文件名的开头，例如 Wealthy 是 `WCCHMSB-`）。
   - 路径用正斜线 `/`。文件夹不存在的话，小程序会自己建。
3. 双击 `start-watcher.bat`。窗口里会写出每一个上传和搬动；同一个目录里的 `watcher.log` 也有记录。窗口要一直开着，关掉就停。

## 日常

- 把单据文件丢进某家公司的 `inbox`（可以一次丢很多），几秒后就会被上传、改名、搬走。
- 到系统，在那家公司的 **Purchases Bill → 收件箱**，按「读取」，检查系统读出来的内容，再保存。
- 同一个文件丢两次不会重复：系统认得出（内容一样），会写「already there」。
- 上传失败（没有网络、token 被停用……）：文件留在 `inbox`，小程序会过一阵再试。

## TNG 每日结算报告（UK、Inviro、Own Laundry）

这三家公司的 TNG / MMSDO 原版月结报告（.xlsx 或 .csv）也可以自动读取：

1. Owner 先到 Control Panel →「TNG Report」，选公司，打勾开通。
2. 在这家公司的那一段设定里加两个文件夹：`tngInbox`（把 MMSDO 报告丢进这里）和 `tngDone`（上传后存放，可不写）。`config.example.json` 里有写法。同一家公司的账单文件夹（`inbox` / `done`）可以不写。
3. 丢进 `tngInbox` 的 .xlsx / .csv 几秒后会被上传，并改名成 `公司简称-TNG-MMSDO-2026_10.xlsx`，搬进 `tngDone`。
4. 到系统 → TNG Report，会看到「收件箱：1 个新文件」，按「打开并生成」就有每个分行的 PDF 和 Excel。
5. 小程序发现不是 MMSDO 报告的文件，不会反复重试，会把它放进 `tngDone` 里的 `_rejected` 子文件夹，并在窗口和 `watcher.log` 写出原因。
6. 旧格式 .xls 不能读：请先在 Excel 里另存为 .xlsx。

## 文件放在 Google Drive 上

文件夹可以直接用 Google Drive 在电脑上同步出来的文件夹（Google Drive for desktop），例如 `G:/My Drive/CCCREST-SYSTEM/OWN-LAUNDRY/tng-inbox`，路径有空格也没问题，用正斜线 `/`。要注意：

- 电脑要开着，Google Drive for desktop 也要在运行；手机传到 Drive 的文件，要等同步到电脑后，小程序才看得到。
- Google Drive for desktop 的设置里，最好选「镜像文件」（Mirror files），不要用「串流」（Stream files）：串流模式下文件可能还没真正下载到电脑，小程序读不到。
- 小程序上传后会把文件搬到「已上传」文件夹，所以 Drive 里的收件文件夹会清空，这是正常的。

## 想让它开机自动跑

按 `Win + R`，输入 `shell:startup`，在打开的文件夹里放一个 `start-watcher.bat` 的快捷方式。

## 只试一次

`node watcher.js --once` 只跑一次扫描就结束，方便测试。

## 安全

- token 就像密码：不要发给别人，不要贴到聊天里。电脑换人或 token 外泄，到 Control Panel 把它「停用」，再生成新的。
- 小程序只会上传 PDF / JPG / PNG / WEBP，每个文件最大 12 MB。
