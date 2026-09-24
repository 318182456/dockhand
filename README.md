# Dockhand 中文化镜像

[Dockhand](https://github.com/Finsys/dockhand)(现代化 Docker 管理界面)的中文化发行版。

## 工作方式

本仓库**不包含也不修改上游源码**。CI 每 6 小时检测一次上游 release,发现新版本后:

1. 拉取上游官方镜像 `fnsys/dockhand:<tag>`
2. 构建期([Dockerfile.zh](Dockerfile.zh))将翻译字典内嵌进 [scripts/zh-runtime/translator.template.js](scripts/zh-runtime/translator.template.js),生成 `build/client/zh-translate.js`,并在 SSR HTML 模板 `</head>` 前注入 `<script>` 标签([scripts/zh-runtime/inject.mjs](scripts/zh-runtime/inject.mjs))
3. 浏览器端由 MutationObserver 按字典([scripts/translation-dict.json](scripts/translation-dict.json),1700+ 条)实时翻译界面文本
4. 重新打包发布;已构建版本记录于 [VERSION](VERSION)

上游怎么发版,这里只做一层轻量补丁——版本升级零冲突。

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

| 原 registry | 镜像站 |
|---|---|
| `docker.io` | `docker.1ms.run` |
| `ghcr.io` | `ghcr.nju.edu.cn` |
| `gcr.io` | `gcr.nju.edu.cn` |
| `quay.io` | `quay.nju.edu.cn` |
| `registry.k8s.io` | `k8s.nju.edu.cn` |
| `nvcr.io` | `nvcr.nju.edu.cn` |

- 镜像站失败时自动回退到原地址,最差等同未开启
- 已在 Dockhand 中配置凭据的 registry(私有镜像)不走镜像站
- 拉取后本地会多出一个镜像站名称的 tag(如 `ghcr.nju.edu.cn/xxx`),指向同一镜像、不占额外空间;请勿删除,更新检测依赖它记录的 digest
- Stack 部署:执行 `docker compose up/pull` 前按相同参数解析镜像列表并预拉取,拉取语义与 compose 一致(`up` 只拉本地缺失的,`--pull always` 全部拉,`--pull never` 跳过);预拉取失败则由 compose 照常从原地址拉取。日志前缀 `[ZhMirror]`
- 仅本机/直连环境生效;Hawser 远程 agent 环境的拉取在 agent 端进行,不受影响

通过环境变量 `ZH_REGISTRY_MIRRORS` 调整:

```yaml
    environment:
      # 关闭
      - ZH_REGISTRY_MIRRORS=off
      # 或自定义(完全替换默认映射)
      # - ZH_REGISTRY_MIRRORS=docker.io=docker.1ms.run,ghcr.io=ghcr.nju.edu.cn
```

## 维护翻译

修订 `scripts/translation-dict.json`(英文原文 → 中文,键按 DOM 文本节点整段精确匹配;≥10 字符的长词条会额外参与子串回退替换)后,手动触发一次 `Sync, Translate and Publish Docker` workflow 即可重新发布当前版本。

代码/日志/终端/编辑器(`pre`/`code`/`textarea`/xterm/CodeMirror/Monaco)内的文本不参与翻译。

## License

上游项目许可见 [LICENSE.txt](LICENSE.txt)。本仓库仅追加运行时翻译层,不改变上游许可条款。
