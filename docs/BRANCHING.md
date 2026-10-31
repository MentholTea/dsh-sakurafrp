# 分支与发布流程

本仓库采用 **main/develop 双分支流**（Git Flow 的主干子集）：日常在 `develop` 上小步提交，
攒够一批后整包合并到 `master`，产生一个 `--no-ff` 合并点 + tag + Release。

> 注：本仓库的历史默认分支叫 `master`（不是 `main`），下文两者等价，统一写 `master`。

## 分支一览

| 分支 | 角色 | 谁能推进 |
|---|---|---|
| `master` | 稳定线。每个提交都对应一个已发布版本 | 只接受 `develop` 的 `--no-ff` 合并 |
| `develop` | 集成线。日常所有改动都在这里 | 直接提交、直接推送 |

两个分支都已开启保护规则：**禁止强制推送、禁止删除**。
因为只有你一个维护者，未开「禁止直推」和「必须 PR」——那样单人开发会很啰嗦。
等有协作者时，到 Settings → Branches 给 `master` 加上 *Require a pull request before merging*。

## 日常开发

```powershell
git switch develop
# ...改代码...
git add -A
git commit -m "fix: 修一下隧道重连"
git push
```

小改动也照样推。推的意义是**远端备份**，不是发布。`develop` 上出现未发布提交是常态。

提交信息建议带前缀：`feat:` 新功能、`fix:` 修复、`docs:` 文档、`chore:` 杂务、`refactor:` 重构。

## 发布

一条命令完成全部动作：

```powershell
./scripts/release.ps1 -Bump patch      # 2.2.0 -> 2.2.1
./scripts/release.ps1 -Bump minor      # 2.2.0 -> 2.3.0
./scripts/release.ps1 -Bump major      # 2.2.0 -> 3.0.0
```

或者显式指定版本：

```powershell
./scripts/release.ps1 -Version 2.3.0
```

发布说明从 `docs/release-notes/vX.Y.Z.md` 读取；该文件不存在时用 `gh --generate-notes` 自动生成；
也可以用 `-Notes "..."` 直接给。

常用参数：

| 参数 | 作用 |
|---|---|
| `-DryRun` | 只自检并打印将执行的动作，不改任何东西 |
| `-SkipTests` | 跳过 `npm test`（不建议） |
| `-NoPush` | 只做本地合并、打 tag、打包，不推不建 Release |
| `-Notes "..."` | 直接给 Release 正文 |

### 脚本做了什么

1. 自检：在 `develop` 上、工作区干净、与远端同步、目标 tag 未被占用
2. 跑 `npm test`
3. 改 `package.json` 版本号，提交为 `chore: 升到 X.Y.Z`
4. 推 `develop`
5. 切 `master`，`git merge --no-ff develop -m "release: vX.Y.Z"`
6. `git tag -a vX.Y.Z`
7. 推 `master` 与 tag
8. `npm pack` 出 `dsh-sakurafrp.tgz`，作为 Release 资产上传
9. 切回 `develop`

### 为什么必须 `--no-ff`

默认的 fast-forward 会把 `master` 直接指到 `develop` 的最新提交，历史变成一条直线——
于是「哪一批小提交属于这次发布」就看不出来了，回滚也没有锚点。
`--no-ff` 强制生成合并提交，`master` 上每个合并点都是一个明确的发布里程碑。

## 紧急修复（hotfix）

线上版本有严重问题、又不想把 `develop` 上半成品一起发出去时：

```powershell
# 1. 从 master 开修复分支
git switch master
git pull --ff-only origin master
git switch -c hotfix/v2.2.1

# 2. 改代码、提交、推上去
git add -A
git commit -m "fix: 紧急修复 XXX"
git push -u origin hotfix/v2.2.1

# 3. 合并回 master 并发布
git switch master
git merge --no-ff hotfix/v2.2.1 -m "release: v2.2.1"
git tag -a v2.2.1 -m "release v2.2.1"
git push origin master --tags

# 4. 把修复回灌到 develop（关键，别漏）
git switch develop
git merge hotfix/v2.2.1
git push

# 5. 删掉修复分支
git branch -d hotfix/v2.2.1
git push origin --delete hotfix/v2.2.1
```

第 4 步漏掉的后果：下次从 `develop` 发布时，这个修复会被覆盖回去，bug 复现。

## 版本号约定

语义化版本：

- **MAJOR** — 破坏性变更（配置格式不兼容、导出接口改了）
- **MINOR** — 向后兼容的新功能
- **PATCH** — 向后兼容的 bug 修复

`package.json` 的 `version` 是唯一权威来源，tag 必须与它一致。面板上显示的版本号也是从这里读的。

## 回滚

发布出问题想退回上一版：

```powershell
# 看上了哪些版本
git tag --sort=-v:refname | Select-Object -First 5

# 方式一：revert 合并点（推荐，保留历史）
git switch master
git revert -m 1 <合并提交SHA>
git commit -m "revert: 回滚 vX.Y.Z"
git push

# 方式二：确认无人使用后，删 tag 重发（有风险，远端 tag 删了也可能已被缓存）
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```

`master` 开了禁止强制推送，所以不能用 `git reset` 硬退——只能用 revert。

## npm 发布

`master` 上的 tag 对应已发布版本。推 npm 时要显式带版本：

```powershell
npm publish
```

只在 `master` 分支上、tag 打过之后执行。`develop` 上的版本永不发布。

## 分支保护相关命令

```powershell
# 查看保护规则
gh api repos/MentholTea/dsh-sakurafrp/branches/master/protection

# 临时解除（例如需要强推修历史），修完记得恢复
gh api -X DELETE repos/MentholTea/dsh-sakurafrp/branches/master/protection
```
