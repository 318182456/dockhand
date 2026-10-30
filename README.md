# Dockhand 国内镜像加速版

基于 [Dockhand](https://github.com/Finsys/dockhand)(现代化 Docker 管理界面)的官方镜像,追加国内镜像加速及下载进度显示。

上游自 [v1.0.54](https://github.com/Finsys/dockhand/releases/tag/v1.0.54) 起已原生支持简体中文。本仓库已移除中文翻译注入层,界面语言由上游处理。

## 工作方式

本仓库**不包含也不修改上游源码**。CI 每 6 小时检测一次上游 release,发现新版本后:

1. 拉取上游官方镜像 `fnsys/dockhand:<tag>`
2. 构建期([Dockerfile.zh](Dockerfile.zh))通过 [scripts/zh-runtime/inject.mjs](scripts/zh-runtime/inject.mjs) 注入镜像加速及日志行刷新,支持镜像拉取、Stack 预拉取及更新检查,不重新编译前端
3. 重新打包发布;已构建版本记录于 [VERSION](VERSION)

## 使用

```yaml
services:
  dockhand:
    image: ghcr.io/318182456/dockhand:latest
    container_name: dockhand
    restart: unless-stopped
    ports:
      - 3000:3000
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - dockhand_data:/app/data

volumes:
  dockhand_data:
```

镜像标签与上游版本一一对应(如 `v1.0.40`),另有 `latest`。

## 镜像加速(默认开启)

在 Dockhand 里拉取镜像(镜像页拉取、创建/更新容器、自动更新、Stack 部署、自更新主镜像及更新器镜像)时,会自动改从国内镜像站拉取,完成后 tag 回原名,容器引用与界面显示均不变:

| 原 registry | 镜像站(按探测优先级排列) |
|---|---|
| `docker.io` | `docker.m.daocloud.io` → `docker.1ms.run` → `docker.xuanyuan.me`* → `docker.linkos.org`* |
| `ghcr.io` | `ghcr.m.daocloud.io` → `ghcr.1ms.run` → `ghcr.nju.edu.cn` → `ghcr.linkos.org`* |
| `gcr.io` | `gcr.m.daocloud.io` → `gcr.nju.edu.cn` → `gcr.linkos.org`* |
| `quay.io` | `quay.m.daocloud.io` → `quay.nju.edu.cn` → `quay.linkos.org`* → `quay.dockerproxy.net`* |
| `registry.k8s.io` | `k8s.m.daocloud.io` → `k8s.nju.edu.cn` → `k8s.linkos.org`* |
| `nvcr.io` | `nvcr.m.daocloud.io` → `nvcr.1ms.run` → `nvcr.nju.edu.cn` |

标 `*` 的为境外节点,无代理时通常较慢,仅作兜底。

- 拉取前按优先级探测镜像站:首站 500ms 内尚未完成时增加一路探测,最多并发两路,最先完成测速的站点胜出。取 manifest 并读取最大层的前 1MB,12 秒内读完才采用(小层读取整层),单站探测总计最多 20 秒。可以识别白名单拒绝(如 daocloud 对个人镜像返回 403)、冷门镜像长时间回源(如 NJU)和限速过低的站点,减少等待慢站的时间
- 同一镜像的并发探测合并为一次,成功结果缓存 60 秒、失败结果缓存 15 秒,最多保留 256 条;实际拉取失败立即使成功缓存失效。缓存只用于选择镜像站,不缓存镜像内容或更新检查的 digest
- 探测通过但实际拉取或 tag 失败时继续尝试其余镜像站,同一次拉取不重复尝试失败站点;全部镜像站失败后才回退到原地址
- 已在 Dockhand 中配置凭据的 registry(私有镜像)不走镜像站
- 拉取后本地会多出一个镜像站名称的 tag(如 `ghcr.nju.edu.cn/xxx`),指向同一镜像、不占额外空间;请勿删除,更新检测依赖它记录的 digest
- 自动回收旧镜像:拉取前记录原镜像与已配置镜像站标签对应的镜像 ID,每 30 秒检查一次。原标签已切换到新版、旧镜像不再被任何容器(含停止的容器)引用,且没有其他用途的标签时,按 ID 非强制删除旧镜像。普通拉取、容器更新和 Stack 预拉取均适用,不会执行全局 prune;Docker 的多标签/引用冲突会保留待重试。队列保存在数据目录的 `zh-image-cleanup.json`,重启后在下次访问对应环境或执行 Stack 操作时恢复。只回收本补丁记录到的旧版本,不会扫描删除历史遗留镜像;当前版本的镜像站标签继续保留供更新检测使用
- Stack 部署:执行 `docker compose up/pull` 前按相同参数解析镜像列表并预拉取(`up` 预拉取本地缺失镜像,`--pull always` 全部拉,`--pull never` 跳过)。选站、换站和完成事件通过上游脱敏回调进入部署输出及运行日志。通过同一 Docker CLI 的 daemon 连接读取 JSON 字节进度,按镜像层显示已下载大小、层百分比和采样速度(MiB/s);解压不计为下载速度,缺少字节信息时不推算。CLI 不支持该连接方式时明确提示并退回普通拉取。
- 同一镜像层在日志视图中保留一行,原地刷新状态与速度;复制/下载日志也保留每层最新状态,普通事件和错误不折叠。客户端资产名称及压缩副本一并更新以避开旧缓存。上游“部署历史”详情仍只在展开时读取日志;实时进度看部署输出浮窗,最新历史日志需刷新页面后重新展开。
- 自更新弹窗:Dockhand 主镜像和更新器镜像均通过本机 Docker 连接接入镜像加速,保留原有 socket/TCP 选择与凭据规则。按层显示大小、百分比和采样下载速度,同层原地刷新;解压不计下载速度。拉取流中的最终错误会中止准备阶段,不继续创建新容器。
- 避免重复回源:显式 `pull` 的镜像全部成功后直接返回成功;整栈 `up --pull always` 的镜像全部就绪后改用 `--pull never` 复用本地镜像。存在失败、未处理的引用或尚未覆盖的单服务依赖时保留原策略,由 Compose 继续处理。
- 更新检查/自动更新:启动时从 `handler.js`/`index.js` 安装请求包装,覆盖独立 registry 模块,支持 `string`、`URL` 和 `Request`。查询上表 registry 的公共镜像元数据时逐站尝试镜像站;已配置且只对应一个源 registry 的镜像站域名(如 `ghcr.nju.edu.cn`)也支持换站。Docker Hub/GHCR 的匿名 challenge/token 无需直连源站;其他 registry 保留真实 challenge。全部镜像站失败后回源,如果源站也无法连接,仍如实报告错误。真实凭据和真实 token 不发给镜像站;关闭加速时请求原样放行。启动日志可查看 `[ZhMirror] 更新检查加速包装已安装`
- 仅本机/直连环境生效;Hawser 远程 agent 环境的拉取在 agent 端进行,不受影响

通过环境变量 `ZH_REGISTRY_MIRRORS` 调整:

```yaml
    environment:
      # 关闭
      - ZH_REGISTRY_MIRRORS=off
      # 或自定义(完全替换默认映射,| 分隔多个镜像站,按顺序尝试)
      # - ZH_REGISTRY_MIRRORS=docker.io=docker.m.daocloud.io|docker.1ms.run,ghcr.io=ghcr.1ms.run|ghcr.nju.edu.cn
```

## 页面维护全局变量

在 Dockhand 的 Settings → Config Sets 中统一维护名为“全局变量”的配置集。原生套件默认使用该配置集；Docker 版可通过 ZH_GLOBAL_ENV_CONFIG_SET=全局变量 显式启用。

每个堆栈继续使用原来的单个 compose.yaml，自己的 .env 仅保留应用专用项。部署、更新、校验及编辑器变量窗口读取配置集的最新值；应用自己的 .env、显式变量和密钥优先。全局值不复制进各堆栈文件。域名列表自动派生 TRAEFIK_DOMAIN_REGEX，不限制域名数量。

已有 global.env 可一次性导入配置集，此后在页面中维护。Config Sets 的全局变量扩展与镜像代理、下载进度分别处理；授权、日志脱敏和正常的应用覆盖规则保留。仅配置集的环境变量作为默认值，网络、端口和标签继续由共享 Compose 预设管理。

## License

上游项目许可见 [LICENSE.txt](LICENSE.txt)。本仓库仅追加镜像加速补丁,不改变上游许可条款。


## 群晖原生套件

原生版在宿主机运行 Dockhand，继续使用 Container Manager 提供的 Docker 引擎。支持 DSM 7.4 的 x86_64 / broadwellnkv2；程序、固定版本 Compose 和守护程序打包到 SPK，用户数据库及凭据不进入安装包。

首次安装后，由管理员执行一次引导，并选择有权管理 Docker 项目目录的 NAS 账号：

```sh
sudo /var/packages/DockhandNative/target/runtime/bootstrap.sh <NAS账号> --repair
sudo synopkg start DockhandNative
```

首次启动自动选择空闲内网端口并保存。通过 DSM 主菜单的“Dockhand 原生设置”配置现有 PostgreSQL、访问 URL、固定端口、代理和可选 Traefik 集成。数据库密码留空保留原值；管理员可测试连接后保存。设置服务独立于数据库，在应用连接失败时仍提供恢复入口。

运行配置位于 NAS 数据卷的 dockhand/native/runtime-env.json，维护账号负责读写。主菜单图标及“打开”入口使用设置的完整 URL；不使用会再次拼接 NAS 域名的 adminurl 字段。服务由宿主机管理，关闭 Dockhand 不停止其他业务容器。

GitHub 的“Build and Publish Synology”工作流生成版本化 SPK 并发布到 Releases。配置仓库变量 PACKAGE_SOURCE_URL 和专用 Secret PACKAGE_SOURCE_PUBLISH_KEY 后，会同步更新 Cloudflare 套件目录。专用凭据仅保存在平台 Secrets，不提交源码。自动检测到程序和原生打包源码均未变化时，不重复发布。

套件源代码位于 synology/source，支持 DSM 版本和架构筛选、历史版本下载及 Range / HEAD。部署时自定义 Worker 域名；文档示例使用 https://nas-package.example.com。

## 上游自动适配与发布

GitHub 的 Gemini Compatibility Agent 在上游镜像发布工作流失败时启动。它提取失败版本的官方 build，调用 Gemini 的有限文件工具修复现有兼容补丁；另一项独立 Gemini 审核和无密钥构建任务分别检查补丁。完整镜像构建、原有回归测试和独立审核全部通过后，创建 PR、自动合并并重新触发镜像发布，成功后继续生成原生 SPK 和更新套件源。发布不会自动安装到 NAS。

仓库 Secret GEMINI_API_KEY 保存接口密钥；变量 GEMINI_BASE_URL 指定 Gemini 原生接口根地址（例如 https://api.example.com/），GEMINI_MODEL 指定模型名，AUTO_ADAPT_ENABLED=true 启用失败自动处理。页面 Settings → Secrets and variables → Actions 可自行调整。手动运行该工作流时，smoke 模式验证真实 API 工具回合并构建当前版本，不改代码、不发布；repair 模式需填写失败的 Sync and Publish Docker 运行 ID。

每个上游版本只自动尝试一个 PR。Agent 最多 16 个模型回合，每次请求至多重试两次；仅可修改 scripts/zh-runtime 中已有生产补丁，不能修改测试、工作流、原生服务权限或凭据。审核或构建失败时保留草稿 PR，不合并。网络、镜像仓库故障以及超出允许范围的上游重构仍可能需要人工处理；自动审核不是兼容性保证。