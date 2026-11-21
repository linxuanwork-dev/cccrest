# Row-level security（公司之间的数据库隔离）

阶段 1 · 第 6 步。**已经装好，但默认关闭**：现在线上的行为和以前完全一样。要打开，在 Railway 的 Variables 加 `RLS_MODE=enforce`，重新部署。关掉：删掉这个变量（或改成 `off`），重新部署。

## 它做什么

以前，公司 A 的资料不会被公司 B 看到，全靠程序里每一条查询都记得带 `company_id`。漏写一个，就会看到别家公司的资料。

现在数据库自己也守着：

- 迁移 061 建了一个只能「被切换成」的角色 `cccrest_app`（不能登入，不能绕过隔离）。
- 52 张带 `company_id` 的表里，**46 张**加了规则 `company_isolation`：这一行的公司必须是这个请求被允许的公司，否则看不到、改不到、也插不进去（连改成别家公司都不行）。
- 打开 `RLS_MODE=enforce` 之后，**不是 Owner 的人**的每一个请求，都会先把数据库连接切成 `cccrest_app`，并告诉数据库「这个人能用哪几家公司」。从那一刻起，即使某条语句忘了写 `company_id`，数据库也只会给出这个人那几家公司的行。
- 请求结束，连接切回原来的身份。切不回去的连接会被丢掉。

「这个人能用哪几家公司」的算法和程序里 `scopeToCompany` 完全一样：员工 = 被分配的公司；Manager = 他管的员工被分配的公司；客户 = 自己的公司。

## 不受影响（照旧不限制）

- **Owner（admin）**：看全部公司。
- **没有登入的请求**：登入页、MT Claim 表单（有它自己的登入）、文件夹监视器（用 token）。这些的隔离仍然靠程序里的过滤。
- 迁移、启动时的工作。

## 故意没加规则的表（要先决定）

| 表 | 原因 |
| --- | --- |
| `users`、`company_staff`、`assignment_requests` | 谁能用哪家公司，由 Owner 管；员工还要能「申请」自己还没有的公司 |
| `audit_log` | 只有 Owner 读，`company_id` 可以是空的 |
| `work_tasks`、`work_recurring` | `company_id` 可以是空（= 我们自己公司的任务） |
| 没有 `company_id` 的表：`dsi_records`、`dsi_quantities`、`dsi_specials`、`dsi_menu_items`、`dsi_history`、`reconciliation_line_items`、`doc_settings`、`ac_config` 等 | 它们靠上一层的行带出公司，数据库层面还没有保护，以后要给它们补 `company_id` 或者用关联规则 |

## 打开之前请先检查

1. **跨公司的流程**：Uncle Koh 每月的发票，会变成**店铺公司**的 Purchases Bill 记录（写进另一家公司）。如果做这个动作的员工没有被分配到那家店铺公司，打开之后这一步会被数据库拒绝。要么把员工也分配到那几家公司，要么这个流程以后改成用 Owner 或受信任的身份跑。
2. 员工刚被批准分配一家公司后，数据库那边最多 10 秒才认得（有 10 秒缓存），程序那边是即时的。
3. 每个请求多 2 次数据库往返（切换身份、切回），在 Railway 同区的数据库上通常是几毫秒。
4. 新建的表，如果有 `company_id`，要在迁移里加一行 `SELECT enable_company_rls('表名');`。`node tools/check-rls.js` 会列出漏掉的表。**打开 `RLS_MODE=enforce` 时，系统启动会自己检查**：角色不能用，或者有表没加规则，就**启动失败**（Railway 会继续运行旧版本），不会在没有保护的情况下悄悄运行。

## 建议的打开方式

1. 在 Railway 上先复制一份测试环境（或者找一个安静的时间），设 `RLS_MODE=enforce`。
2. 用员工账号、Manager 账号、客户账号各走一遍日常工作：Sales、Purchases、Stock Count、Attendance / Payroll、补习中心、HR 文件、TNG、账目检查。
3. 看服务器日志有没有 `row-level security` 的错误；有，就是某个流程碰到了没分配给这个人的公司（见上面第 1 点）。
4. 都没问题，再在正式环境打开。
