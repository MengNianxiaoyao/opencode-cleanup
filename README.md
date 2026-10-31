# opencode 清理工具

一个本地网页小工具，用来清理 opencode 的数据：已关闭项目、空项目/孤儿记录、归档会话、旧版 storage 缓存，支持把会话移动到其它项目，并支持备份还原。

## 要求

- Node.js 22.5 或更高（用到内置 `node:sqlite`）
- 本机装过 opencode CLI 或 OpenChamber 其中任意一个

## 运行

Windows：

```
start.cmd
```

macOS / Linux：

```
sh start.sh
```

也可以直接：

```
node cleanup.mjs          # 只启动服务
node cleanup.mjs --open   # 启动并打开浏览器
```

默认地址 `http://127.0.0.1:5199`，被占用会自动往后找端口；可用 `PORT=6000 node cleanup.mjs` 指定。

## 数据位置

工具会自动寻找：

- `opencode db path` 的输出
- 环境变量 `OPENCODE_DB`
- 环境变量 `OPENCODE_DATA_DIR`
- `$XDG_DATA_HOME/opencode`
- `~/.local/share/opencode`（Windows 为 `%USERPROFILE%\.local\share\opencode`）
- `%APPDATA%\opencode`、`%LOCALAPPDATA%\opencode`

OpenChamber 设置按顺序找：

- `OPENCHAMBER_DATA_DIR/settings.json`
- `$XDG_CONFIG_HOME/openchamber/settings.json`
- `~/.config/openchamber/settings.json`
- `~/Library/Application Support/openchamber/settings.json`
- `%APPDATA%\openchamber\settings.json`

OpenCode 桌面版设置：`ai.opencode.desktop`（含 `.beta` / `.dev`）下的 `opencode.settings`，位于 `%APPDATA%`、`$XDG_CONFIG_HOME` 或 `Application Support`。

## 备份

删除前会把数据写到 `backups/`，工具里的「备份与还原」可以还原或删除这些备份。旧版缓存删除时也会先复制一份再删。会话移动同样会备份，可以从备份还原回原来的项目。

## 目录结构

```
cleanup.mjs        入口
src/core.mjs       路径解析、数据库、快照、备份读取
src/actions.mjs    删除/还原/重开/移动等操作
src/server.mjs     本地 HTTP 服务
public/index.html  预览界面
```
