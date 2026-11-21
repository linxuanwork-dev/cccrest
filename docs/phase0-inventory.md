# 系统重构 · 阶段 0：盘点（写死清单）

依据：《系统重构规格书》第七节阶段 0。日期：2026-11-21。只是读代码整理出来的清单，**没有改任何程序**。

## 一、现在的系统和规格书的差别

| 规格书的表 / 概念 | 现在有没有 | 现状 |
| --- | --- | --- |
| `companies` | 有（部分） | 有 name、slug、type、short_name、公司资料栏位、`enabled_features`（每家公司开哪些页面） |
| `branches` | 没有统一的表 | 各模块各有一份：`dsi_branches`（Madam Lua / UK Lua / Uncle Koh 的分店）、`tng_outlets`（TNG 的 outlet）、补习中心的 BBU / TST / TDA 写在程序里 |
| `company_settings` | 没有 | 每个模块自己有一张设定表：`doc_settings`、`purchase_bukku_settings`、`stock_count_settings`、`tuition_settings`、`attendance_settings`、`sales_recon_settings`、`tng_settings`、`ac_config`、`bukku_connections` |
| `account_mappings` | 没有统一的表 | 分散：`purchase_bukku_contacts`（contact 和 account）、`bukku_accounts`、`bukku_contacts`、`dm_customer_lookup`、`dsi_menu_items.account_code` |
| `sources` / `imports` | 没有 | 各模块自己存上传的文件：`inbox_files`、`tng_files`、`docs`、`*_docs` |
| `transactions` / `matches` / `exceptions` / `approvals` | 没有 | 每个模块各有自己的表和自己的"已批准"状态（如 `purchase_bukku_bills.approved_at`）。最早的一版（`001_init.sql`）有 `sales_records`、`bank_statement_entries`、`petty_cash_entries`、`reconciliation_batches` 等，现在还被「报告」页和 `reconciliation.js` 使用，要搬进标准交易时一起处理 |
| `tasks` | 有（相近） | `work_tasks`、`work_recurring`（044） |
| `audit_log` | 有 3 份，没有统一 | `activity_log`（001）、`document_events`（013）、`tax_audit`（056）。格式不一样，也没有统一做到"不能改、不能删" |
| `employees` / `attendance` / `payroll_runs` | 有（相近） | `employees`、`employee_salary_history`、`attendance_docs`、`payroll_entries` |
| 角色 CC / Manager / 员工 / 客户 | 名字不同 | 现在是 `admin` / `manager` / `staff` / `client`，另外每页有权限和 `can_approve` |
| 公司之间用 `company_id` 分开 | 有 | 49 个栏位带 `company_id`，靠程序里的 `scopeToCompany` 过滤 |
| 数据库层的 row-level security | **没有** | 迁移里没有任何 RLS。隔离全靠程序，写漏一个过滤就会看到别家公司的资料 |
| 自定义栏位、标准列表组件 | 没有 | 每页自己写自己的表格 |
| 提示中心、合规日历、Sync with Bukku 按钮 | 部分 | Bukku 连接和采购单发送有；提示中心、合规日历、统一的 Sync 没有 |

## 二、程序里写死的东西

### A. 按公司名称写死（要搬进公司设定）

| 位置 | 写死的内容 |
| --- | --- |
| `index.html`（约 4409 行） | 公司名 → 简称对照：MINIFISH=MF、INVIRO、OWN LAUNDRY=OL、DIDIK MULIA=DM、WEALTHY=WCCHMSB |
| `index.html`（约 7446–7459 行） | `RECON_ONLY_COMPANY = 'OWN LAUNDRY SDN. BHD.'`、`DM_INVOICE_COMPANY = 'DIDIK MULIA SDN. BHD.'`；`SALES_SUMMARY_OVERRIDES` 按公司名决定 Sales 页显示哪一个专用面板（Own Laundry、Didik Mulia、Madam Lua、UK Lua、Uncle Koh）；`MERCHANT_REPORT_OVERRIDES` |
| `index.html`（约 7125–7143 行） | 「Company E No.」的功能只对名字以 `SK SPRAY PPF` 开头的公司生效 |
| `index.html` | `FEATURE_PANELS` 页面清单；各页注释里写着"只给 Didik Mulia / Own Laundry"的限制 |
| `server/lib/hqBill.js` | HQ 账单：QC GROUP → Didik Mulia 的分校 |
| `server/routes/mtClaim.js`、`tuitionAllowance.js` | MT Claim 登入、补习中心逻辑，直接写 Didik Mulia |
| `tools/folder-watcher/config.example.json` | 文件夹对应哪家公司 |
| `server/seed.js`、`seed-data/` | 初始公司和客户资料 |

### B. 单号前缀、分校、account、contact 写死

| 位置 | 写死的内容 |
| --- | --- |
| `server/lib/dmInvoiceRules.js` | 分校 `TDA` / `TST` / `BBU`；account `5000-01`（注册费）、`5000-03`（模块费）；单号格式 `IV-分校-R/M年月-序号`；货品说明格式 |
| `server/routes/tuitionAllowance.js`、`assets/tuition/app.html` | 分校 BBU / TST / TDA（共约 20 处）、MT allowance 的算法 |
| `server/lib/ukTngReportRules.js` | outlet `UKD` / `UKTN` / `UKTU` / `UKHP` / `UNCLE_KOH`、前缀、account `1000-01` |
| `server/lib/olTngReportRules.js` | 只写了 TNG 的交易类型（`DUITNOW_QR_TNGD` 等），没有写死公司或 outlet；这个报告只有 Own Laundry 用，是 `index.html` 按公司名控制的 |
| `server/routes/purchaseBukku.js` | 默认 account `6000-01` |
| `server/lib/dailySalesRules.js` | 单号由分店设定拼出（`invoice_prefix` 在 `dsi_branches`）：这一项**已经是设定**，不算写死 |

### C. 法律数字写死在程序里（要搬进"法规规则"，按生效日期做版本）

| 位置 | 写死的内容 |
| --- | --- |
| `server/lib/statutory.js` | EPF 率（员工 11%，雇主 12% / 13%）、EPF 级距、60 岁以上的规则、加班费公式（MINIFISH 的算法：底薪 ÷ 26、÷ 7.5 …）、SKBBK 起算日 `2026-06` |
| `server/lib/statutoryTables.js` | SOCSO 全表、EIS 全表 |
| `server/lib/eaPdf.js` | EA 表格版面 |
| `server/assets/taxb/rules/2025.json`、`2026.json` | 个人所得税的规则：**已经是按 YA 版本的规则，是做得对的那一种**，可以当做法规规则的样板 |

## 三、哪些东西已经做对了（可以直接用）

- 个人所得税的规则按 YA 版本、草稿 / 定案、批准后才生效，正是规格书第十节要的做法。
- 修改记录（`tax_audit`）：谁、什么时候、改前改后、原因，不能关。可以拿它的做法当统一 `audit_log` 的样板。
- Bukku 连接（`bukku_connections`、`bukku_accounts`、`bukku_contacts`）已经有，账目检查也已经在读 Bukku。
- 每日销售单号由分店设定拼出，不写死。

## 四、建议的阶段 1（地基），先不动现有功能

**原则：只加不改。** 加新表、把写死的东西一个一个搬进设定；每搬一个，新旧结果必须一样才切换。

1. **新表**（迁移 057 起）：`company_settings`（key、value、生效日期、谁改的）、`branches`（统一分店 / outlet）、`account_mappings`、`sources`、统一的 `audit_log`（不能改、不能删）。
2. **先搬公司名字写死的部分**：`index.html` 里按公司名称决定显示哪个面板的那些，改成读 `company_settings`（例如 `sales_panel = didik_mulia / own_laundry / daily_sales`）。公司改名也不会坏掉。这一项最安全，因为只是页面显示。
3. **再搬分校 / outlet / 前缀 / account**：Didik Mulia 的分校和 account、TNG 的 outlet，先建成 `branches` 和设定，程序改读设定，输出的文件要和现在逐字一样。
4. **法规规则版本**：把 EPF、SOCSO、EIS 搬进"法规规则"，按生效日期做版本，用现有的薪资结果对比，必须一样。
5. **审计**：把 `activity_log`、`document_events` 的新记录同时写进统一的 `audit_log`，旧的暂时不动。
6. **Row-level security**：放到阶段 2 之前单独评估，因为它要改每一个数据库连接，改动面大。

## 五、要你决定的事

1. 阶段 1 照上面的顺序做可以吗？还是你想先做别的（例如先做提示中心、先做 Sync with Bukku、先做薪资的 payslip / EA）。
2. 角色：现在是 `admin` / `manager` / `staff` / `client`，规格书是 CC / Manager / 员工 / 客户。我的建议是**内部保留现在的名字，只在画面上显示规格书的叫法**，免得动到所有的权限判断。同意吗？
3. Row-level security 要不要做，什么时候做？现在是程序层面隔离，风险是以后新写的功能漏了过滤。
4. 规格书第四节开始的"标准交易"那一整套（`transactions` 等）改动很大，我建议阶段 2 才开始，并且只先接一个模块试（采购单，因为它已经有批准、Bukku 发送的流程）。
