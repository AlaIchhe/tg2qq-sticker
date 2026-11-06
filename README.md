# tg2qq-sticker

把 **Telegram 贴纸** 存进 **QQ 收藏表情** 的小管线：你私聊自己的 Telegram bot 发一张贴纸，它就出现在你 QQ 的「收藏 → 表情」里。**不往 QQ 发任何消息**，只做收藏入库。

- 支持 Telegram 三种动态格式：静态 `.webp`、视频贴纸 `.webm`、Lottie `.tgs`
- 单张入库 / 整包入库（`/group`）
- 整包**打成 zip 发回**（`/zip`）：发一张贴纸，得到它所在表情包的压缩包（静态→PNG，动态→GIF 240×240 50fps）
- 自动写备注（贴纸自带的 emoji）
- 按 md5 去重，重复发不会重复存
- `/del` 只删自己加过的，不会误删你原有收藏

---

## 为什么动态图输出 GIF 而不是 APNG / WebP

这是本项目最重要的一个结论，用数字计时器贴纸逐张实测出来的（完整方法见 [docs/qq-format-compatibility.md](docs/qq-format-compatibility.md)）：

| 格式 | 帧间隔 20ms | 帧间隔 100ms | 结论 |
|---|---|---|---|
| **GIF** | ✅ 精确执行 | ✅ | 唯一能到 50fps 的格式 |
| **APNG** | ❌ 50 帧变 5 秒 | ⚠️ 时长也会偏 | 每帧固定 ≈100ms，写的延时无效 |
| **动态 WebP** | ❌ 无法做到 1 秒 | ✅ 可用 | 同样被限在 ≈10fps |

也就是说：**QQ 只会精确执行 GIF 的帧延时**，APNG / WebP 一律被压到约 10fps。如果你把 60fps 的 APNG 直接塞进 QQ，它会变成「帧数 × 100ms」的慢放——而且从文件本身完全看不出问题。

所以默认 `format: "gif"`，50fps（每帧 20ms）。代价是 GIF 只有 1 位透明，边缘会有点硬。

## 架构

```
你 ──私聊──▶ Telegram Bot API（长轮询）
                  │  贴纸元数据 / getFile / 下载文件
                  ▼
             bridge.mjs ── .tgs ──▶ render-tgs.py（rlottie 逐帧渲染）
                  │                .webm ─▶ ffmpeg 解码
                  │  逐帧 PNG ──▶ ffmpeg 编成 GIF（palettegen/paletteuse，保留透明）
                  ▼
             OneBot 11 WS（ws://127.0.0.1:3001）
                  │  add_custom_face / set_custom_face_desc / fetch_custom_face_detail
                  ▼
                NapCatQQ（headless QQNT）──▶ QQ 收藏表情（云端同步到手机）
```

## 前置条件

1. **NapCatQQ** 已经跑起来并登录了目标 QQ，OneBot WS 端口开在 `127.0.0.1:3001`
   （它提供 `add_custom_face`、`set_custom_face_desc` 这些非标准扩展动作）
2. NapCat 容器里能访问到一个临时目录，用来上传收藏文件（见下文 `favHostDir` / `favContainerDir`）
3. Python 3.11+，用来跑 rlottie 渲染
4. 一个 Telegram bot token（@BotFather 建）
5. 本机 Node.js 18+（代码用了内置 `fetch` 和 `WebSocket`，无需 npm 依赖）

## 安装

```bash
git clone https://github.com/AlaIchhe/tg2qq-sticker.git
cd tg2qq-sticker

# 1) 渲染器（独立 venv，不污染系统 Python）
python3 -m venv /opt/lottie-venv
/opt/lottie-venv/bin/pip install -r requirements.txt

# 2) token
printf '%s' '123456:ABC...' > token && chmod 600 token

# 3) 配置
cp deploy/config.example.json config.json
$EDITOR config.json

# 4) systemd
sudo cp deploy/tgqq.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tgqq
journalctl -u tgqq -f
```

首次给 bot 发消息的那个 TG 账号会被自动绑定为 owner（写在 `config.json` 的 `allowUsers`），之后其他人发一律拒绝。

## 配置说明

`config.json` 全部字段都有默认值，按需覆盖：

| 字段 | 默认 | 说明 |
|---|---|---|
| `onebot.ws` | `ws://127.0.0.1:3001` | NapCat 的 OneBot WS 地址 |
| `allowUsers` | `[]` | 允许的 TG user id；空数组时第一个发消息的人自动绑定 |
| `format` | `gif` | 动态图输出格式：`gif`（推荐）或 `apng`（会被 QQ 压到 10fps） |
| `size` | `240` | 输出边长（正方形），QQ 收藏表情这个尺寸足够 |
| `fps` | `20` | 仅 `format: apng` 时生效 |
| `descMode` | `emoji` | 备注内容：`emoji` / `pack`（表情包名）/ `both` / `none` |
| `favHostDir` | `/root/work/wakaba/tgqq-tmp` | 宿主机上的收藏上传临时目录 |
| `favContainerDir` | `/data/wakaba/tgqq-tmp` | 上面这个目录在 NapCat 容器内的路径 |
| `lottiePython` | `/opt/lottie-venv/bin/python` | rlottie 渲染器解释器路径 |

> `favHostDir` 与 `favContainerDir` 必须指向**同一个目录**（bind mount 的两端）：
> `add_custom_face` 只接受 NapCat 进程能读到的本地路径。

## 机器人命令

| 命令 | 作用 |
|---|---|
| 直接发贴纸 / 图片 | 按当前模式处理：single 存这一张，group 自动导入整包 |
| `/single` | 切到 **single 模式**：之后每张贴纸都单独存（默认模式，会持久化） |
| `/group` | 切到 **group 模式**：之后每发一张贴纸，自动导入它所在的整个表情包 |
| `/group t.me/addstickers/包名` | 立即导入指定包，并切到 group 模式 |
| `/zip` | 切到 **zip 模式**：之后发一张贴纸，把它所在的整个表情包按统一格式转换后打成一个 zip 发回来（不写收藏） |
| `/zip t.me/addstickers/包名` | 立即转换指定包并发回 zip，同时切到 zip 模式 |
| `/count` | 当前收藏数量 |
| `/del` | 删除最近由本 bot 添加的一张（不会动其他收藏） |
| `/delete_all` | 清空收藏里的**全部**表情；需在 60 秒内再发 `/delete_all confirm` 确认，不可恢复 |
| `/id` | 查看自己的 TG id |
| `/help` | 用法 |

整包导入会先发一条状态消息，然后原地编辑成 `导入中 12/34：新增 11，跳过 1，失败 0`，不刷屏。

## 已知限制

- `.tgs` 需要逐帧渲染，单张约 1~3 秒；50fps 下整包导入会比较慢
- `/zip` 的 zip 里每张按原格式转换：静态 `.webp` → PNG（保留原分辨率、alpha），动态 `.webm`/`.tgs` → GIF 240×240 50fps；34 张动态包约 10 分钟、约 38MB
- Bot API 上传文档上限 50MB；总量超过 45MB 时自动按卷拆分，一条请求可能收到多个 zip（标题带「分卷 i/n」）
- `/zip` 依赖系统里的 `zip` 命令（`apt install zip`）
- GIF 只有 1 位透明，抗锯齿边缘会比 APNG 硬
- QQ 单张收藏大小上限、收藏总数上限均未知（实测 3.8MB 的文件可以存）
- 只在手机 QQ 上验证过播放行为，桌面端可能有差异

## 第三方依赖与许可证

本项目**不分发、不修改**下面任何一个项目，全部通过独立进程或网络接口调用：

| 项目 | 用途 | 许可证 |
|---|---|---|
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | QQ 侧协议端，提供 OneBot WS 与 `add_custom_face` 等扩展动作 | 自定义 [Limited Redistribution License](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)（本项目不重分发，需自行安装） |
| [OneBot 11](https://github.com/botuniverse/onebot-11) | 接口规范 | 规范文档 |
| [rlottie](https://github.com/Samsung/rlottie) | Lottie/.tgs 渲染引擎 | MIT（个别子目录另议） |
| [rlottie-python](https://github.com/laggykiller/rlottie-python) | rlottie 的 Python 绑定 | LGPL-2.1（独立进程调用，不链接） |
| [Pillow](https://python-pillow.org/) | 渲染帧写出 PNG | MIT-CMU / HPND |
| [FFmpeg](https://ffmpeg.org/) | VP9 解码、缩放、GIF 编码 | LGPL/GPL（取决于构建；Debian 构建为 GPL-2+） |
| [Telegram Bot API](https://core.telegram.org/bots/api) | 收消息、取贴纸文件 | Telegram 服务条款 |

## 风险与免责声明

- NapCat 是注入式第三方 QQ 客户端，**有被腾讯风控/封号的风险**；本项目只做收藏入库，不群发消息，但风险无法消除
- 建议用小号，不要用主号
- 本项目仅用于个人备份自己的表情收藏，请勿用于侵权内容分发

## License

MIT，见 [LICENSE](LICENSE)。
