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

普通单网页服务在堆栈变量中填写 `TRAEFIK_SUBDOMAIN` 和 `TRAEFIK_CONTAINER_PORT`，例如 `myapp`、`3000`，并使用以下标签。容器端口填写内部 HTTP 端口，不是宿主机映射端口。

```yaml
labels:
  - "traefik.enable=true"
  - "dockhand.subdomain=${TRAEFIK_SUBDOMAIN:?请填写子域名前缀}"
  - "dockhand.url=https://${TRAEFIK_SUBDOMAIN}.${TRAEFIK_DOMAIN}:${TRAEFIK_HTTPS_PORT}"
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}.entrypoints=websecure"
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}.tls=true"
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}.service=${TRAEFIK_SUBDOMAIN}-web"
  - "traefik.http.services.${TRAEFIK_SUBDOMAIN}-web.loadbalancer.server.port=${TRAEFIK_CONTAINER_PORT:?请填写容器内部端口}"
```

使用标签列表，因为 Compose 不会插值映射形式的标签键。同一 Traefik 实例中前缀应唯一。多服务、多端口和特殊 API 路由需要分别配置；SSO、代理和后端 HTTPS 按应用选择。

保留用户原来的 Compose 配置，只合并所需字段。例如需要代理的服务可以写 `HTTP_PROXY: "${HTTP_PROXY}"`；原有 `NO_PROXY` 等设置继续保留。全局变量不会自动全部传入容器，需要在服务配置中引用。

### 同一个容器的网页和 API

多端口应用需要分别设置 router、service、TLS 和容器端口。例如已有网页路由的 Hindsight 可以补上以下标签，API 默认使用同一前缀加 `-api`：

```yaml
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}.rule=HostRegexp(`^${TRAEFIK_SUBDOMAIN}[.](${TRAEFIK_DOMAIN_REGEX})$$`)"
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}-api.rule=HostRegexp(`^${TRAEFIK_SUBDOMAIN}-api[.](${TRAEFIK_DOMAIN_REGEX})$$`)"
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}-api.entrypoints=websecure"
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}-api.tls=true"
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}-api.service=${TRAEFIK_SUBDOMAIN}-api"
  - "traefik.http.routers.${TRAEFIK_SUBDOMAIN}-api.middlewares=basic-headers@file"
  - "traefik.http.services.${TRAEFIK_SUBDOMAIN}-api.loadbalancer.server.port=${TRAEFIK_API_PORT:-8888}"
```

`TRAEFIK_DOMAIN_REGEX` 由本扩展在部署时从 `TRAEFIK_DOMAINS` 自动生成、去重并转义，不用在配置集中手动维护第二份域名列表。上例的 `$$` 会由 Compose 转为正则表达式的结尾锚点 `$`。更改域名列表后，除了重新部署 Traefik，也需重新部署使用这种显式标签的多路由应用。普通单路由应用可以继续使用提供器的默认规则。


### 优先级与生效方式

每次堆栈操作都会重新读取配置集，不缓存。应用自己的 `.env`、自定义 env 文件、堆栈已有变量和秘密变量优先，包含显式空值。值按字面量传递，不展开全局值里面的 `$OTHER_VAR`。本扩展不改写用户的 Compose 文件或默认模板，也没有新增“选择配置集插入标签”的界面。

Config Sets 是普通配置存储，密码继续使用秘密变量/提供器。拥有所选配置集编辑权限的用户能影响全部引用它的堆栈，应按全局配置管理权限。禁止使用 `DOCKER_*`、`COMPOSE_*`、`NODE_*`、`LD_*`、`DYLD_*`、`PATH`、`HOME` 等执行控制变量。配置集缺失、重名、重复变量或非法变量会中止操作并报错。

修改全局值后，重新部署受影响的堆栈才会更新容器，不会自动重建正在运行的服务。改变 URL 端口变量不会改变 Traefik 实际监听/映射，切换入口时需同步调整。关闭功能可删除 `ZH_GLOBAL_ENV_CONFIG_SET` 或设为 `off`。外部终端直接运行 `docker compose` 仍须自行提供变量。

本地/直连和 Hawser 共用变量分派入口。单元测试及实际官方镜像补丁注入验证不等同于真实 Hawser agent 部署验证。


## License

上游项目许可见 [LICENSE.txt](LICENSE.txt)。本仓库仅追加镜像加速补丁,不改变上游许可条款。
