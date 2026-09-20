# 交接：服务器落后于代码 + deploy key + 换行符收口（2026-09-20）

**这一轮本来只是「检查本地和远端有没有差异」，查出三件事**：

1. `git status` 报的 20 个「已修改」文件是**假的**（纯换行符），已用 `.gitattributes` 根治
2. 🔴 **服务器上的代码落后于工作区** —— `eb0e351`（手机号 + 密码登录）一行都没上去
3. 🔴 **假登录还开着**，而且原因跟上一份交接（`2026-09-20-对外开放与管理员账号.md`）写的**不一样了**

另外给服务器配了 **deploy key**，它现在能直接 `git push`。

---

## 一、`.gitattributes` —— 20 个文件是假改动

### 现象

`git status` 报 20 个文件已修改，`git diff --stat` 显示 **7436 行增 / 7436 行删**。
`admin.bat` 是 127 增 127 删，`colors.js` 是 76 增 76 删 —— **每个文件都是增删相等的**。

### 怎么确认它是假的

逐字节比过：把工作区文件和 HEAD 各自去掉 `\r` 再算 sha256，**全部相同**。
另一个更快的判据：

```bash
git diff --ignore-all-space --stat     # 输出是空的
```

**「增删行数完全相等」+「忽略空白后 diff 为空」= 换行符，不是内容。**

### 成因

仓库没有 `.gitattributes`，`core.autocrlf` 也没设（`git config` 两个都取不到值）。
HEAD 里存的是 LF，这台机器上的工具把工作区写成了 CRLF。

### 处理

新增 `.gitattributes`：

```
* text=auto eol=lf
*.bat text eol=crlf
*.cmd text eol=crlf
```

然后 `git add --renormalize .` 让索引按新规则重算。**提交不改任何文件内容**，
只改 git 看待它们的方式（`git diff --stat origin/master HEAD` 只有 `+317` 行，全是新文件）。

**已验证**：新 clone 一份出来，`admin.bat` / `teacher.bat` 是 CRLF，
`colors.js` / `images.js` 是 LF。`git ls-files --eol` 显示两个 bat 是 `i/lf w/crlf attr/text eol=crlf`。

🔴 **`*.bat` 那条不是洁癖，是真事故**：`teacher.bat` 存成 LF 时 cmd.exe 逐行解析会把中文注释
切错位，报一串 `'---' is not recognized as an internal or external command` ——
**报错指向的内容跟真正的原因（换行符）毫无关系**，很难倒着查回来。
`admin.bat` 一直是 CRLF 所以它没事，两者差别只在换行符，**所以只能靠规则守，靠人记不住**。

⚠️ **本机的工作区文件没有被改动**（内容和换行符都原样），变的只是 git 的比对基准。

---

## 二、服务器上的代码落后于工作区（本轮查出，未处理）

### 判据

上一份交接教的命令（**`--strip-trailing-cr` 不能省**）：

```bash
diff --strip-trailing-cr -rq /opt/stem-app /root/workspace/stem-app \
  -x node_modules -x .git -x .local-images -x dist \
  -x package-lock.json -x '.env' -x '.env.bak*' -x '*.stackdump'
```

上一份交接记的是「**零差异**」。**现在不是了。**

### 服务器缺的东西

| 缺 | 后果 |
|---|---|
| `backend/src/db/migrations/022_teacher_identity.sql` | **数据库没跑迁移 022** |
| `backend/src/routes/activate.js` | **激活接口整个不存在** |
| `backend/src/utils/phone.js` | 手机号校验不存在 |
| `frontend/src/pages/login/`、`frontend/src/pages/redeem/` | 登录页、兑换页不存在 |
| 其余 `backend/scripts/*`、`src/**` 十余处 | `eb0e351` 的改动都没上 |

**已核实到数据库层**（不是靠读代码推的）：

```sql
select filename from schema_migrations where filename like '022%';   -- 空
select column_name from information_schema.columns
  where table_name='teachers' and column_name in ('phone','password_hash','salt');
-- 空：列都不存在
```

⚠️ `schema_migrations` 的列名是 **`filename` / `executed_at`**，
没有 `version` 列 —— 第一次查用了 `select version` 直接报错。

### ⚠️ 反方向只有两个文件，别看成「服务器更新」

`rebind-test.mjs`、`dev-activate.mjs` 只有服务器上有 ——
它们在工作区里是**故意删掉的**（`eb0e351` 删的），服务器上留着是废弃残余。

### 影响面

**在线老师数为 0**，所以还没有人受害。但这条是「下一步绕不过去」，不是「可以一直挂着」。

⚠️ **部署方式不是 `git pull`**：大陆机器连不通 GitHub（见 `ADR-003`），
是打包 + `scp`。**服务器上这份 `/opt/stem-app` 不是 git 仓库**，
所以这次配的 deploy key **只解决了从服务器往外推**，没解决往服务器上部署。
反过来，现在既然服务器能连 GitHub 了（实测 `curl https://github.com` 返回 200），
可以考虑改成 `git pull` —— **但这要另外验证，别顺手就改**。

---

## 三、🔴 假登录还开着，而且护栏变了

### 现状

```
/opt/stem-app/backend/.env:  NODE_ENV=development
                             DEV_FAKE_LOGIN=true
```

**80 现在是对公网开着的**（上一轮打开的，`http://115.29.167.18`），所以这不是理论风险。

### 🔴 上一份交接的判断已经过期，这里重写

它写的是「**最坏情况是有人拿这个 IP 烧一点 API 费用**，拿不到数据、进不了后台」，
理由是当时有三道护栏。**现在只有一道半还在**：

| 护栏 | 当时 | 现在（2026-09-20 核实） |
|---|---|---|
| `DEV_FAKE_LOGIN` 只在 `NODE_ENV !== 'production'` 时生效 | ✅ | ✅ **还在**（`config.js:134`） |
| 「走到已激活之后的业务」被 `requireActivated` 挡住 | ✅ | ⚠️ **仍然挡得住，但靠的是 022 没跑**，不是设计 |
| 假登录建出的老师**无法自己激活自己** | 👈 当时没这一项 | ⚠️ **`activate.js` 一部署上去，这条路就通了** |

**第二行是这轮最该记住的事**：`requireActivated` 的前半段（`!activated_at`）
在**工作区**里已经被新身份模型绕过了（CLAUDE.md 里就写着「只死了一半」），
服务器上之所以还拦得住，纯粹因为 `activate.js` 还没部署 ——
**是「东西没上」拦住的，不是「设计拦住了」。两道闸门同时不在。**

**结论**（最坏情况）**没变，但理由变了**：现在拦得住是偶然，不是设计。

### 怎么收掉

把 **迁移 022 + `eb0e351` 部署上去**（顺带就把 `/login` 换成了真登录），
然后 `NODE_ENV=production`。

⚠️ **顺序要紧**：迁移 022 必须先跑，否则新代码起来会撞上不存在的 `teachers.phone` 列。
⚠️ **改完 `.env` 必须 `systemctl restart stem-app`** —— 后端不读实时变更。

---

## 四、服务器上的 deploy key（这轮新配的）

### 为什么配

`git push` 在服务器上失败：

```
fatal: could not read Username for 'https://github.com': No such device or address
```

**不是「第一次要输密码」** —— 服务器上 `credential.helper` 什么都没配、也没有 keyring，
**git 想弹框问凭据时无处可问**。不配的话它会一直这么失败，不会自己变好。

🔴 **`git push` 不会自动记住凭据。** 这条值得单独记：它的表现（「读不到 Username」）
看起来像「还没登录过」，实际上像「没地方给它登录」。

### 配了什么

- **deploy key**（`~/.ssh/github_stem_app`，ed25519，无密码）
  挂在**仓库级** Settings → Deploy keys，**勾了 Allow write access**
- `~/.ssh/config` 加了一段 `Host github.com` → `IdentityFile ~/.ssh/github_stem_app`
  + **`IdentitiesOnly yes`**
  - ⚠️ 必须写 config：**服务器上 ssh-agent 不持久**，只把 key 文件放进 `~/.ssh/`
    不会自动被用
- remote 从 HTTPS 换成 SSH：`git remote set-url origin git@github.com:linem7/stem-app.git`

**为什么用 deploy key 不用 PAT**：这把钥匙**只开这一个仓库、只能写这一个仓库**，
跟你账号里其他仓库完全无关，而且能单独吊销。这台是**公网可达的生产服务器**，
落上去的凭据越窄越好。

⚠️ **明文存储这条路已经堵死**：装了 `git-credential-store`，但**没有 gnome-keyring**，
`credential.helper store` 就是把 token 明文写进 `~/.git-credentials`。

### 验证

```bash
ssh -T git@github.com
# Hi linem7/stem-app! You've successfully authenticated, ...
```

🔴 **`Hi` 后面带的是仓库名**（不是用户名）—— 这是**仓库级 deploy key 生效的特征**，
顺带能确认没加到账号级 Settings → SSH keys 去（那页跟仓库的 Deploy keys 页长得很像）。

### 要收掉它

GitHub 仓库 Settings → Deploy keys 删掉那条即可，服务器上那个私钥文件就废了。

---

## 五、接着做什么

### 0. 排在最前面的两件（本轮查出）

① **决定要不要把 `eb0e351` 部署上去**（含迁移 022）。
   部署完 `/login` 自动变成真登录，假登录那件事跟着一起收掉。
② 如果不部署，**至少把 `DEV_FAKE_LOGIN` 关掉**，
   但那样老师端就一个人都进不去了（新登录没上）—— 所以这两件是绑在一起的。

### 1. 原先挂着没动的（上一份交接的清单仍然有效）

- **域名 + 个人 ICP 备案 + HTTPS** —— 上线闸门，只能用户办
- **问卷站**（A/B/C 三条路）—— 用户要拍板，**C 会动身份模型**，不能当「加个页面」做
- **`backend/.env.example` 还残留作废项**（`WECHAT_APPID` / `WECHAT_SECRET` /
  `CONTENT_CHECK_ENABLED`，说明写着「小程序审核」）
  - ⚠️ 它正是部署时照着填的那张清单，**留着会让人填一堆已经作废的项**（2026-08-31 就挂过）
- **找回密码 / 改手机号**那两个超管动作还没做
- **`MEMORY.md` 的「悬着的事」那一节写的还是腾讯云**，跟 `ADR-003` 换阿里云矛盾了

---

## 六、给下一个人的话

- 🔴 **别信「服务器上的代码 = 工作区代码」这句话**，哪怕上一份交接写着「零差异」。
  **跑一遍那条 `diff --strip-trailing-cr`**，十秒钟的事
- 🔴 **`git status` 报「已修改」但增删行数相等时，先怀疑换行符**，
  别去逐行读 diff。`git diff --ignore-all-space --stat` 是空的就结案了
- 🔴 **交接文档里的判断会过期，尤其是「最坏情况是什么」那种**。
  这一轮就撞上一次：假登录那段的前提（`activate.js` 不存在）已经不成立
- **用户已经拍板的事别重新讨论**：「先开着」（他知道情）、「不用加 swap」、
  管理员账号用 `lin`、`* text=auto eol=lf` 这个取向
- ⚠️ **这台机器是用户的线上服务器**，不是他的电脑。在上面装任何东西、放任何凭据之前先想一遍
- **他问「`git push` 会不会自动记住凭据」时，答的是「不会」** ——
  这题他真问过，答案是非直觉的那一侧
