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

## 维护翻译

修订 `scripts/translation-dict.json`(英文原文 → 中文,键按 DOM 文本节点整段精确匹配;≥10 字符的长词条会额外参与子串回退替换)后,手动触发一次 `Sync, Translate and Publish Docker` workflow 即可重新发布当前版本。

代码/日志/终端/编辑器(`pre`/`code`/`textarea`/xterm/CodeMirror/Monaco)内的文本不参与翻译。

## License

上游项目许可见 [LICENSE.txt](LICENSE.txt)。本仓库仅追加运行时翻译层,不改变上游许可条款。
