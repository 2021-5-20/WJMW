# 吴江麻王

手机与电脑浏览器四人好友房。房主用账号密码开桌，牌友可点链接或输入九位房号，以游客或正式账号入座。首页提供回桌入口，结算后四人准备可继续下一局。战绩按场保存，每局可查骰子、财神、倍率、台数和四家分差。

## 规则版本

新房间使用 `wj-2`，开桌时锁定版本。庄家为东，其他玩家的自风随庄位轮转。金张为中、发、白。自风或金张成刻加 1 台，明杠合计 2 台、暗杠合计 3 台。普通明杠 1 台、暗杠 2 台。碰碰胡、混一色各 3 台，清一色、三财神各 10 台，大吊车加 1 台，取消三碰承包。

自己摸牌时持三张财神可直接胡。手牌仍未组成通常胡型时以三财神 10 台结算，再乘当局倍率。已成型的手牌同时计算适用项目，三财神计一次。豹子、财神为任一风牌或金张，单项触发当局乘 2。两项同现，从这一局起连续三局乘 2，流局保留当前次数，再次双触发就从当局重新计三局。旧版 `wj-1` 牌桌与历史沿用开桌时的规则。

## 本地开发

使用 Node.js 24.7 或更新版本、PostgreSQL 18。创建空的开发库，并给应用连接账号授予在该库 public schema 中建表的权限。启动服务时会初始化数据库并恢复活跃牌桌。

```powershell
npm ci
$env:DATABASE_URL='postgresql://开发用户:开发密码@127.0.0.1:5432/mawang_dev'
$env:APP_ORIGIN='http://localhost:2567'
$env:MAIL_PREVIEW_DIR=Join-Path $env:TEMP 'mawang-local-mail'
npm run build
npm start
```

浏览器打开与 `APP_ORIGIN` 完全一致的地址。开发邮件以 JSON 写入指定的私有目录，可在本机打开其中的验证或重置链接。生产环境通过 SMTP 投递。使用 Vite 热更新时，将 `APP_ORIGIN` 改为实际开发页面地址，启动游戏服务，再另开终端运行 `npm run dev`。

## 公网部署

1. 在 Linux 服务器安装 Docker 和 Compose。为域名配置 A/AAAA 记录，放通 TCP 80 和 443。将独立备份存储挂载在主机上，并授予容器内 postgres 用户读写权限。可用 `docker run --rm postgres:18-bookworm id postgres` 查看数字 UID/GID。
2. 复制 `.env.example` 为 `.env`。填写域名、两个独立的随机数据库密码、实际备份挂载路径、发信地址，以及 SMTP 服务的连接串。使用 `smtps://用户名:密码@服务器:465` 或服务商指定的 STARTTLS 配置，连接串中的特殊字符需 URL 编码。限制 `.env` 的读取权限。
3. 每次发布设置独立的 `MAWANG_RELEASE` 镜像标签，然后执行以下命令。

```sh
docker compose config --quiet
docker compose build game
docker compose up -d --no-build
docker compose ps
docker compose logs --tail 30 backup
```

Caddy 使用同一域名处理 HTTPS 和 WebSocket。游戏、PostgreSQL 均只接入容器网络。一个数据库同时允许一个游戏服务实例运行；通过单进程房间队列和数据库事务，在向玩家确认之前保存动作与结算。更新期间可断开连接，进程恢复后重新给当前动作完整响应时间。首页的回桌入口可用于恢复原座。首次从早期内存版切换时，先等原有牌桌打完。

`/health/ready` 检查服务初始化及数据库连接。管理员通过正常网页登录后访问 `/ops`，可看活跃房间数、查指定桌的累计分和最近结算，以及按编号查服务异常。由数据库管理员根据已验证的账号授予 `accounts.is_admin`，查询操作记入 `ops_audit`。数据库中断时，异常编号仍可在游戏服务日志检索。

## 备份、恢复和回退

Compose 将数据库文件放在 `postgres_data` 持久卷中。数据库持续将 WAL 发送到 `MAWANG_BACKUP_DIR/wal`；备份服务每天产生一个基础备份，通过 `pg_verifybackup` 后才放入该挂载点的 `base/时间戳` 目录。首次部署需检查基础备份完成、WAL 文件持续到达以及备份盘可用空间。归档目录应专供该数据库实例使用。保留多份经恢复演练的基础备份和对应的连续 WAL，按存储保留策略一并管理。

空环境还原演练可在独立临时容器执行。下面的时间戳换成实际备份目录。每份基础备份完成后会额外创建命名恢复点，并等待该段 WAL 在备份盘落盘。演练容器通过自己的 Unix socket 读取恢复副本，确认 WAL 已重放至该恢复点，再核对账号、房间和逐局结算数。预留相当于数据库大小的可用空间。

```sh
docker compose run --rm --no-deps --entrypoint sh backup /ops/restore-drill.sh /backup/base/实际时间戳
```

主机丢失时，在新主机、空数据卷上用同一 PostgreSQL 主版本恢复已验证的基础备份，并重放后续 WAL；核对业务记录后再切流量，同时恢复域名、SMTP 和应用配置。进程中断看最后一次数据库提交，整块磁盘损坏时恢复点取决于异机 WAL 归档进度。绝对时间点恢复可使用 PostgreSQL 的 `recovery_target_time`。[PostgreSQL 连续归档与恢复](https://www.postgresql.org/docs/18/continuous-archiving.html)

发布前保留当前镜像标签、数据库备份与验证记录。替换兼容应用版本时设置旧 `MAWANG_RELEASE`，执行 `docker compose up -d --no-build --no-deps game`，检查 readiness、已有玩家回桌、规则版本与历史结算。如目标镜像不支持活跃桌的规则版本，使用支持该规则的镜像恢复服务。严禁在正常应用回退时删除数据卷。

## 验证

- `npm run check` 和 `npm run build` 分别执行类型检查与浏览器生产构建。
- `npm test` 运行规则测试；设置 `TEST_DATABASE_URL` 指向可创建独立 schema 的专用测试库后，同一命令还会运行认证、HTTP 权限、四人座位与进程故障恢复测试。每个测试文件只清理自己创建的测试 schema。
- `npm run load` 使用实际 HTTP 入座请求和 WebSocket 连接，在回环地址的专用 `mawang_load` 数据库中创建独立压测 schema（通过 `DATABASE_URL` 提供连接，保留 schema 供核对）。默认 100 桌、400 名模拟玩家、60 分钟，含集中重连、结算核对及操作确认延迟。可用 `LOAD_TABLES` 和 `LOAD_SECONDS` 缩短冒烟测试。首发容量需在目标机器和公网网络上复测。
