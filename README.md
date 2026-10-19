# Dockhand 国内镜像加速版

基于 [Dockhand](https://github.com/Finsys/dockhand)(现代化 Docker 管理界面)的官方镜像,追加国内镜像加速功能。

上游自 [v1.0.54](https://github.com/Finsys/dockhand/releases/tag/v1.0.54) 起已原生支持简体中文。本仓库已移除中文翻译注入层,界面语言由上游处理。

## 工作方式

本仓库**不包含也不修改上游源码**。CI 每 6 小时检测一次上游 release,发现新版本后:

1. 拉取上游官方镜像 `fnsys/dockhand:<tag>`
2. 构建期([Dockerfile.zh](Dockerfile.zh))通过 [scripts/zh-runtime/inject.mjs](scripts/zh-runtime/inject.mjs) 注入服务端镜像加速补丁,支持镜像拉取、Stack 预拉取及更新检查
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

在 Dockhand 里拉取镜像(镜像页拉取、创建/更新容器、自动更新、Stack 部署)时,会自动改从国内镜像站拉取,完成后 tag 回原名,容器引用与界面显示均不变:

| 原 registry | 镜像站(按顺序尝试) |
|---|---|
| `docker.io` | `docker.m.daocloud.io` → `docker.1ms.run` → `docker.xuanyuan.me`* → `docker.linkos.org`* |
| `ghcr.io` | `ghcr.m.daocloud.io` → `ghcr.1ms.run` → `ghcr.nju.edu.cn` → `ghcr.linkos.org`* |
| `gcr.io` | `gcr.m.daocloud.io` → `gcr.nju.edu.cn` → `gcr.linkos.org`* |
| `quay.io` | `quay.m.daocloud.io` → `quay.nju.edu.cn` → `quay.linkos.org`* → `quay.dockerproxy.net`* |
| `registry.k8s.io` | `k8s.m.daocloud.io` → `k8s.nju.edu.cn` → `k8s.linkos.org`* |
| `nvcr.io` | `nvcr.m.daocloud.io` → `nvcr.1ms.run` → `nvcr.nju.edu.cn` |

标 `*` 的为境外节点,无代理时通常较慢,仅作兜底。

- 拉取前逐个探测镜像站:取 manifest 并读取最大层的前 1MB,12 秒内读完才采用(小层读取整层),单站探测总计最多 20 秒,否则跳过换下一个。可以识别白名单拒绝(如 daocloud 对个人镜像返回 403)、冷门镜像长时间回源(如 NJU)和限速过低的站点
- 同一镜像的并发探测合并为一次,成功结果缓存 60 秒、失败结果缓存 15 秒,最多保留 256 条;实际拉取失败立即使成功缓存失效。缓存只用于选择镜像站,不缓存镜像内容或更新检查的 digest
- 全部镜像站不可用或拉取失败时回退到原地址,最差等同未开启
- 已在 Dockhand 中配置凭据的 registry(私有镜像)不走镜像站
- 拉取后本地会多出一个镜像站名称的 tag(如 `ghcr.nju.edu.cn/xxx`),指向同一镜像、不占额外空间;请勿删除,更新检测依赖它记录的 digest
- Stack 部署:执行 `docker compose up/pull` 前按相同参数解析镜像列表并预拉取,拉取语义与 compose 一致(`up` 只拉本地缺失的,`--pull always` 全部拉,`--pull never` 跳过);预拉取失败则由 compose 照常从原地址拉取。日志前缀 `[ZhMirror]`
- 更新检查/自动更新:查询 Docker Hub 镜像的远端 digest 时同样按上表顺序改走镜像站,不再依赖 `auth.docker.io`(国内常连不上,连不上时上游会把公开镜像误报为 "Registry denied access (401) - private image or missing credentials")。全部镜像站失败时回退到 Docker Hub;已在 Dockhand 配置 Docker Hub 凭据时仍直连 Docker Hub,凭据不会发给镜像站
- 仅本机/直连环境生效;Hawser 远程 agent 环境的拉取在 agent 端进行,不受影响

通过环境变量 `ZH_REGISTRY_MIRRORS` 调整:

```yaml
    environment:
      # 关闭
      - ZH_REGISTRY_MIRRORS=off
      # 或自定义(完全替换默认映射,| 分隔多个镜像站,按顺序尝试)
      # - ZH_REGISTRY_MIRRORS=docker.io=docker.m.daocloud.io|docker.1ms.run,ghcr.io=ghcr.1ms.run|ghcr.nju.edu.cn
```

## License

上游项目许可见 [LICENSE.txt](LICENSE.txt)。本仓库仅追加镜像加速补丁,不改变上游许可条款。
