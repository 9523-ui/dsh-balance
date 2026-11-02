# dsh-balance

在 DeepSeek Harness 对话框下方显示当前账户余额的小插件。

> A tiny DeepSeek Harness plugin that shows your DeepSeek account balance in the
> composer dock and refreshes it on demand.

## 它做什么

- 在聊天输入框下方的 `conversation.composer.dock` 里显示一个余额胶囊：`余额 ¥12.34`。
- 优先读取 DSH 账号服务（`deepseekAccount.getBalance`，也就是免费额度 / 平台登录这份余额）；
  没有账号服务时回退到 `DEEPSEEK_API_KEY` 对应的官方 `/user/balance` 接口。
- 鼠标悬停显示充值 / 赠送明细和更新时间；点击立即刷新。
- 页面可见时每 60 秒自动刷新一次；Host 侧对成功结果缓存 30 秒，避免多标签页重复请求。
- 查询失败时显示「余额不可用」，悬停可看到原因（未登录、Key 无效、网络失败等）。

插件只把格式化后的金额发送给浏览器，API Key 和账号 token 不会离开 Host 进程。余额接口只读，不会修改账户。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半侧：注册 `/dsh-balance/summary`、`/dsh-balance/refresh` 两个只读接口 |
| `client.js` | 浏览器半侧：注册对话框下方的余额胶囊 |
| `cordis.patch.yml` | 把插件行插进 profile |
| `locale/zh.json`、`locale/en.json` | 插件管理页显示的标题和说明 |
| `icon.svg` | 插件图标 |

## 安装

在插件管理页安装本目录，或用 CLI：

```powershell
dsh plugin --profile desktop add "C:\path\to\dsh-balance"
```

桌面版安装后，Host 半侧会随 profile 重新加载；如果页面里还没出现余额胶囊，刷新一次页面即可。只有 Host 接口也还不存在时（例如安装时应用完全退出），才需要重启 DeepSeek Harness。

## 配置

无需配置。若要改用 API Key 余额：

1. 在 DSH 设置里配置 `DEEPSEEK_API_KEY`；
2. 退出 DeepSeek 账号登录（或让账号服务不可用）。

插件会先尝试账号余额，失败后自动回退到 API Key。

## 接口

```text
GET  /dsh-balance/summary   # 读取缓存（30 秒内直接返回）
POST /dsh-balance/refresh   # 强制重新查询
```

成功响应示例：

```json
{
  "ok": true,
  "source": "deepseek-account",
  "currency": "CNY",
  "symbol": "¥",
  "total": "12.34",
  "granted": "2.34",
  "toppedUp": "10.00",
  "wallets": [{ "currency": "CNY", "symbol": "¥", "total": "12.34", "granted": "2.34", "toppedUp": "10.00" }],
  "updatedAt": "2026-10-23T07:00:00.000Z"
}
```

失败响应示例：

```json
{ "ok": false, "reason": "unauthorized", "message": "DeepSeek API Key 无效或已过期" }
```

## 卸载

```powershell
dsh plugin --profile desktop remove "@local/dsh-balance"
```

如果只是暂时不想看到它，在插件管理页把它关闭即可。

## 开发

```powershell
npm test
```

测试不需要启动 DeepSeek Harness：`test/host.mjs` 用假的 ctx 覆盖余额解析与两个接口，
`test/client.mjs` 检查浏览器半侧的注册参数。

## License

[MIT](./LICENSE)
