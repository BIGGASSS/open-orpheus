# Open Orpheus

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/BIGGASSS/open-orpheus/checks.yml)
![GitHub License](https://img.shields.io/github/license/BIGGASSS/open-orpheus)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/BIGGASSS/open-orpheus/total)
![GitHub Repo stars](https://img.shields.io/github/stars/BIGGASSS/open-orpheus)

[English Version](docs/README_en.md)

一个对网易云音乐 Orpheus 浏览器宿主的开源实现。

上游项目的开发计划：https://github.com/users/YUCLing/projects/3

## 功能

- Linux（Wayland、X11）和 macOS 的原生 Nix 构建
  - Linux：x86_64 和 aarch64；macOS：仅 aarch64（Apple Silicon）
  - 固定的 nixpkgs 26.11 已移除 Intel Mac 支持
  - 原生 CI 检查构建与测试；图形界面的运行仍需在目标系统验证
  - 不提供 Windows 或跨平台交叉构建
- 开源

不然你还想要啥！它本质上就是给原版客户端提供一个运行环境！

## 截图

<details>
<summary>主界面</summary>

![主界面](assets/screenshots/1.png)

</details>

<details>
<summary>播放界面</summary>

![播放界面](assets/screenshots/2.png)

</details>

<details>
<summary>设置界面</summary>

![设置界面](assets/screenshots/3.png)

</details>

<details>
<summary>迷你播放器和桌面歌词</summary>

![迷你播放器和桌面歌词](assets/screenshots/4.png)

</details>

<details>
<summary>迷你播放器列表</summary>

![迷你播放器列表](assets/screenshots/5.png)

</details>

## 安装

本仓库仅维护 **Nix** 打包和发布。旧的发行版安装包、Copr、Flathub、AppImage 和 Windows 发布流程已从本仓库移除；这不代表上游或第三方发行渠道停止提供服务。

安装启用了 `nix-command` 和 `flakes` 的 Nix 后，在仓库根目录执行：

```sh
nix build .#default # 同 nix build；生成 result
nix run            # 构建并启动
nix flake check    # 应用构建、测试、lint 和 Rust 检查
```

`packages.default` 与 `packages.open-orpheus` 指向同一个应用；`apps.default` 提供启动入口。构建面向本机的 `x86_64-linux`、`aarch64-linux` 或 `aarch64-darwin`，不做交叉编译。

[Releases](https://github.com/BIGGASSS/open-orpheus/releases) 提供按系统区分的 `open-orpheus-SYSTEM.nar.zst` Nix 运行时闭包，而非独立安装程序；导入和运行仍需要 Nix。完整设置、闭包导入与故障排查见[构建指南](docs/building.md)。

### 开发

```sh
nix develop
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:modules
pnpm start
# 在同一开发环境中运行检查
pnpm test
pnpm lint
```

pnpm 和 Cargo 是 Nix 环境内部的构建工具；保留并提交 `pnpm-lock.yaml`、`Cargo.lock` 和 `flake.lock`。详见[贡献指南](CONTRIBUTING.md)。

### 资源文件

这个项目不会打包某些必需资源，因为它们归网易所有。

Open Orpheus 在首次启动时如果检测到资源缺失，会自动从网易的 CDN **自动下载**，通常无需手动配置。

资源存放在数据目录的子文件夹 `package` 中：

- 开发模式：`data/package/`（相对于工作目录）
- 打包后：`{userData}/package/`

#### `package` 和 `resource` 文件夹

整个 `package` 和 `resource` 文件夹都是必需的。

如果自动下载失败，可以从官方网易云音乐的安装目录手动复制这两个文件夹，例如 `C:\path\to\your\installation\CloudMusic\package`，并将其放入上述数据目录中。**注意：`package` 是 `package` 文件夹的子文件夹，也就是说复制完后应该是 `package/package/`！**

## 使用文档

- [Nix 构建、运行和开发](docs/building.md)
- [Wayland 窗口规则配置文档](./docs/WM_RULES.md)

## 免责声明

Open Orpheus 是一个以**互操作性**为目的的独立开源项目，与网易公司没有任何关联、授权或认可关系。

- **本项目不包含、不分发任何归网易所有的资产或代码。** 运行所需的资源文件（如 `orpheus.ntpk`）归网易公司所有，用户须自行从合法取得的官方客户端中获取，或由程序在首次启动时从网易官方 CDN 自动下载。
- **本项目不提供、不鼓励、不支持任何用于绕过广告、付费内容、会员权益或数字版权保护机制（DRM）的功能或修改。** 任何此类用途均明确超出本项目的范围，且会被主动抵制。
- 使用本项目时，您仍需遵守网易云音乐的[网易云音乐服务条款](https://st.music.163.com/official-terms/service)及相关法律法规。
- 本项目按"现状"提供，不对因使用本项目所产生的任何后果（包括但不限于账号封禁、服务中断或法律责任）承担责任。

> "网易云音乐"、"Orpheus" 等名称及相关商标归网易公司所有。
