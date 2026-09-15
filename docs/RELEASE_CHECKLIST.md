# 发布检查事项 / Release checklist

本仓库只发布 Nix 运行时闭包，不生成发行版安装包、AppImage、Windows 安装包，也不向 Copr 或 Flathub 推送。这不代表外部渠道停止运行。完整命令见[构建指南](building.md)。

## 1. 准备提交 / Prepare the commit

- [ ] 手动更新 `package.json` 版本号并提交；工作流不会自动改版本、提交代码或生成 AI 更新日志。
- [ ] 依赖有变化时，同步提交 `pnpm-lock.yaml`、`Cargo.lock` 和相关 `flake.lock` 更新。
- [ ] 运行 `nix flake check` 和 `nix build .#default`。
- [ ] 在桌面会话中用 `nix run` 验证启动、播放、设置、托盘和退出；注明实际验证的系统。不要把 CI 构建等同于图形界面的运行验证。
- [ ] 确认 PR/push 的三个原生 CI 任务成功：`x86_64-linux`、`aarch64-linux`、`aarch64-darwin`。固定的 nixpkgs 26.11 已移除 Intel Mac 支持。不使用 Windows 或交叉编译。

## 2. 推送标签 / Push the tag

- [ ] 在已审核的提交上创建并推送 `v<package.json version>` 标签（例如版本 `0.17.0` 对应 `v0.17.0`）。预发布版本使用类似 `v0.18.0-rc.1` 的标签。
- [ ] 确认 `Release` 工作流由该 `v*` 标签推送触发。它先验证版本匹配，再以不可变的 `github.sha` 调用复用构建工作流；不要移动发布标签。

## 3. 检查产物 / Verify publication

- [ ] 三个构建都通过 `nix flake check`，并显式执行 `nix build .#default`。
- [ ] 发布包含以下全部非空文件（缺失任何闭包都会使发布失败）：
  - `open-orpheus-x86_64-linux.nar.zst`
  - `open-orpheus-aarch64-linux.nar.zst`
  - `open-orpheus-aarch64-darwin.nar.zst`
- [ ] 文件是 `nix-store --export` 导出的完整运行时依赖闭包，经 zstd 压缩；不是可直接解压运行的安装程序。按[构建指南](building.md)在对应系统导入并测试。
- [ ] 检查 GitHub 自动生成的发布说明；分类保留在 [`.github/release.yml`](../.github/release.yml)。不再维护旧安装包元数据或触发外部渠道发布。

工作流通过 `gh` 创建草稿并上传所有闭包，成功后才公开发布；包含连字符的版本标签会标记为预发布。现有 release 不会被自动删除或覆盖。若上传失败留下草稿，请人工检查后清理草稿并重跑，保留原标签和提交。
