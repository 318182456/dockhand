# Dockhand 国内镜像加速版

基于 [Dockhand](https://github.com/Finsys/dockhand)(现代化 Docker 管理界面)的官方镜像,追加国内镜像加速及下载进度显示。

上游自 [v1.0.54](https://github.com/Finsys/dockhand/releases/tag/v1.0.54) 起已原生支持简体中文。本仓库已移除中文翻译注入层,界面语言由上游处理。

## 工作方式

本仓库**不包含也不修改上游源码**。CI 每 6 小时检测一次上游 release,发现新版本后:

1. 拉取上游官方镜像 `fnsys/dockhand:<tag>`
2. 构建期([Dockerfile.zh](Dockerfile.zh))通过 [scripts/zh-runtime/inject.mjs](scripts/zh-runtime/inject.mjs) 注入镜像加速、日志行刷新及可选的堆栈全局变量补丁,支持镜像拉取、Stack 预拉取及更新检查,不重新编译前端
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

## 堆栈全局变量（可选）

本镜像可以从 Dockhand 的 **Config Sets（配置集）** 中读取 Compose 插值默认值。官方配置集仍是创建容器时的预设；此扩展只读取选定配置集的环境变量，不批量套用标签、端口、挂载、网络或重启策略。

在 Config Sets 创建“全局变量”，例如：

| 变量 | 示例值 | 用途 |
|---|---|---|
| `TRAEFIK_DOMAINS` | `example.com,example.net` | 反代根域名列表，逗号分隔，可继续增加 |
| `TRAEFIK_DOMAIN` | `example.com` | Dockhand 快捷链接使用的主域名 |
| `TRAEFIK_HTTPS_PORT` | `9443` | HTTPS 外部端口 |
| `HTTP_PROXY` | `http://proxy.example.org:7890` | 可选代理 |
| `HTTPS_PROXY` | `http://proxy.example.org:7890` | 可选代理 |
| `NO_PROXY` | `localhost,127.0.0.1` | 按实际网络填写 |

可以自行增加业务变量，在 Compose 中通过 `${变量名}` 引用。在 **Dockhand 自己的** Compose 中启用后重新部署：

```yaml
environment:
  ZH_GLOBAL_ENV_CONFIG_SET: "全局变量"
```

如果使用列表写法，应写成 `- ZH_GLOBAL_ENV_CONFIG_SET=全局变量`；不要在等号后的值外再套双引号。

### Traefik 的统一域名规则

在 Traefik 服务的 Compose 中传入域名列表：

```yaml
environment:
  TRAEFIK_DOMAINS: "${TRAEFIK_DOMAINS}"
```

在 Traefik 静态配置中设置 Docker 提供器的 `defaultRule`，按容器的 `dockhand.subdomain` 标签和全局域名列表生成规则：

```yaml
providers:
  docker:
    exposedByDefault: false
    defaultRule: >-
      {{- $prefix := index .Labels "dockhand.subdomain" -}}
      {{- $rules := list -}}
      {{- if $prefix -}}
      {{- range $value := splitList "," (env "TRAEFIK_DOMAINS") -}}
      {{- $domain := trim $value -}}
      {{- if $domain -}}
      {{- $rules = append $rules (printf "Host(`%s.%s`)" $prefix $domain) -}}
      {{- end -}}
      {{- end -}}
      {{- end -}}
      {{- if $rules -}}{{ join " || " $rules }}{{- else -}}Host(`disabled.invalid`){{- end -}}
```

保留已有提供器的 endpoint、watch 等配置。新增根域名后，重新部署 Traefik 以更新其环境变量。采用默认规则的应用不需要逐个改域名标签；显式写了 `*.rule` 的路由优先使用显式规则。DNS 和证书也需覆盖新增域名。

### 新建堆栈只填写前缀和端口

完整 Traefik 标签可以集中保存在一份 [共享预设](examples/traefik/compose-presets.yml) 中。把它放在堆栈公共父目录下，例如 `traefik/compose-presets.yml`，并在全局配置集中添加：

```dotenv
TRAEFIK_PRESET_FILE=../traefik/compose-presets.yml
```

每个服务只需引用预设，保留原来的镜像、代理、挂载、网络等字段：

```yaml
extends:
  file: "${TRAEFIK_PRESET_FILE}"
  service: web
```

每个堆栈只填写两个变量，例如：

```dotenv
TRAEFIK_SUBDOMAIN=myapp
TRAEFIK_CONTAINER_PORT=3000
```

共享预设已固定 `traefik.enable=true`，无需传开关。不需要反代的服务不引用预设。端口是容器内部 HTTP 端口，不是宿主机映射端口；同一 Traefik 实例中的前缀应唯一。需要 SSO 的服务改用 `service: web-sso`，认证中间件在共享预设中统一维护。qBittorrent 和 Transmission 分别使用基于它的 `web-qb`、`web-tr`，保留各自的客户端兼容请求头；容器网络选择仍保留在应用配置中。

Compose 插值变量对整个项目生效，同一堆栈的多个独立服务不能通过各自的 environment 重定义插值参数。Emby、SunPanel 等多入口堆栈使用共享文件中的专用预设，每个入口保留独立的前缀和端口变量。

文件只保存一份，每个需要反代的服务都引用它。相对路径按该服务主 Compose 文件所在目录解析。预设及堆栈文件必须在运行 Compose CLI 的 Dockhand 容器内可读，通常把共同父目录按相同路径挂载到容器内。

### 同一个容器的网页和 API

Hindsight 等双端口应用改用 `service: web-api`。这份预设自动提供独立的两套 router、service、TLS 和端口：

| 入口 | 子域名前缀 | 容器端口 |
|---|---|---|
| 网页 | `TRAEFIK_SUBDOMAIN` | `TRAEFIK_CONTAINER_PORT` |
| API | 上述前缀加 `-api` | 默认 `8888`，可用 `TRAEFIK_API_PORT` 覆盖 |

不用把整套标签重复写进每个应用。`TRAEFIK_DOMAIN_REGEX` 由 Dockhand 在部署时根据全局 `TRAEFIK_DOMAINS` 自动生成、去重并转义，不用在配置集中维护第二份域名列表。更改域名列表后，重新部署 Traefik 和引用预设的应用，使其标签读取最新值。

`extends` 复用配置结构，全局变量提供域名、代理等值，两者互相配合。也可以不用本扩展，改为自行配置 Compose 读取共享 `.env`；服务里的 `env_file` 只向容器传变量，不能代替 Compose 插值变量来源。

编辑器的缺失变量标记和右侧变量窗口同样识别全局默认值。右侧单独显示名称、来源和值，列表及文件编辑模式都可查看；在原生 Config Sets 权限允许时读取值，同名堆栈变量仍优先。这里展示全局默认值，不写入各堆栈的 .env。

Validate 的隔离校验进程也会读取所选全局配置集，并按已有堆栈目录或新堆栈的默认目录解析 extends 路径。校验不会写回应用文件；未启用全局功能时保留上游行为。

新建窗口会在打开、预览和校验时读取当前默认模板，不再始终使用页面初始化时缓存的旧值。不会覆盖正在编辑的内容或调用方显式传入的 Compose。


### 优先级与生效方式

每次堆栈操作都会重新读取配置集，不缓存。应用自己的 `.env`、自定义 env 文件、堆栈已有变量和秘密变量优先，包含显式空值。值按字面量传递，不展开全局值里面的 `$OTHER_VAR`。本扩展不改写用户的 Compose 文件或默认模板，也没有新增“选择配置集插入标签”的界面。

Config Sets 是普通配置存储，密码继续使用秘密变量/提供器。拥有所选配置集编辑权限的用户能影响全部引用它的堆栈，应按全局配置管理权限。禁止使用 `DOCKER_*`、`COMPOSE_*`、`NODE_*`、`LD_*`、`DYLD_*`、`PATH`、`HOME` 等执行控制变量。配置集缺失、重名、重复变量或非法变量会中止操作并报错。

修改全局值后，重新部署受影响的堆栈才会更新容器，不会自动重建正在运行的服务。改变 URL 端口变量不会改变 Traefik 实际监听/映射，切换入口时需同步调整。关闭功能可删除 `ZH_GLOBAL_ENV_CONFIG_SET` 或设为 `off`。外部终端直接运行 `docker compose` 仍须自行提供变量。

本地/直连和 Hawser 共用变量分派入口。单元测试及实际官方镜像补丁注入验证不等同于真实 Hawser agent 部署验证。


## License

上游项目许可见 [LICENSE.txt](LICENSE.txt)。本仓库仅追加镜像加速补丁,不改变上游许可条款。


### 共享 global.env

可设置 `ZH_GLOBAL_ENV_FILE=/volume1/docker/all/global.env`，每次部署和校验直接读取该文件。该模式优先于旧 Config Set，保留项目 `.env`、数据库变量及原生 secret 的覆盖优先级，不把共享值写进各项目 `.env`。变量面板显示文件来源与当前值。

共享文件保持权限 600，不提交到 Git。它用于 Compose 插值，不会自动作为整个容器的环境变量文件；仅应用 Compose 明确引用的变量会传入容器。群晖界面本身不会自动读取该文件，命令行使用共享变量时需显式传 `--env-file`。
