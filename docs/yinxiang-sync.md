# 中国版印象笔记同步

核实日期：2026-10-24（Asia/Shanghai）。

## 官方协议核对

- [认证](https://dev.yinxiang.com/doc/articles/authentication.php/) 明确使用 OAuth 1.0：先向 `/oauth` 获取临时 token，再跳转到 `/OAuth.action`，回调带 `oauth_token` 和授权成功时的 `oauth_verifier`，最后仍向 `/oauth` 换取访问 token。中国版生产端点使用 `app.yinxiang.com`，沙箱使用 `sandbox.yinxiang.com`。
- 访问 token 响应包含 `edam_userId`、毫秒级 `edam_expires`、用户专属 `edam_noteStoreUrl`；文档示例中的 `oauth_token_secret` 为空，因此实现允许空字符串。
- [API Key 权限](https://dev.yinxiang.com/doc/articles/permissions.php/) 区分创建权限与读取权限。Inkstone 只把成功探测到的 `notes.read`、`notebooks.read`、`resources.read` 展示为已验证权限，不因 OAuth 完成就假定正文或附件可读。
- [NoteStore 参考](https://dev.yinxiang.com/doc/reference/NoteStore.html) 将 `getSyncState`、`getFilteredSyncChunk` 定义为 Thrift API；实现使用 `application/x-thrift` 二进制请求，不臆造 REST 笔记接口。同步使用 `afterUSN`、`chunkHighUSN`、`updateCount` 和 `fullSyncBefore`，检查点只在本地处理批次后推进。
- [ENML](https://dev.yinxiang.com/doc/articles/enml.php) 是印象笔记正文格式；转换器过滤脚本、事件属性和危险链接，并保留无法解析资源的警告。
- OAuth 临时状态以哈希保存并写入回调 URL，回调同时校验当前 Inkstone 用户、浏览器会话、request token、一次性消费标记和状态哈希。
- [应用笔记本](https://dev.yinxiang.com/doc/articles/app_notebook.php) 属于额外权限范围。第一版只展示接口实际返回的笔记本，并将 `application` / `shared` 标记保留在界面数据中，不把共享或企业笔记本伪装成普通笔记本。

## 配置

服务端只配置以下变量，不能放入前端环境变量或仓库：

```toml
[vars]
YINXIANG_ENVIRONMENT = "sandbox"
YINXIANG_CALLBACK_URL = "https://notes.example.com/oauth/yinxiang/callback"

# 使用 wrangler secret put，不要写入 wrangler.toml
# YINXIANG_CONSUMER_KEY = "placeholder"
# YINXIANG_CONSUMER_SECRET = "placeholder"
```

也可以在已登录的站长账号中打开 **设置 → 中国版印象笔记**，在“印象笔记服务配置”区域填写 Consumer Key、Consumer Secret、生产/沙箱环境和 OAuth 回调地址。保存后 Secret 会写入 CredentialVault 加密存储，页面不会再次显示完整值；留空 Secret 可保留原值。数据库配置优先于环境变量配置。

生产使用前，需要在印象笔记开发者中心申请并激活生产 API Key，并把回调地址加入应用配置。用户必须在官方印象笔记页面自行登录、授权或拒绝；Inkstone 不填写密码、验证码，也不保存 Cookie。

## 当前实现范围

已实现 OAuth 会话绑定、一次性回调消费、来源账号隔离、可信 NoteStore 主机校验、加密 token 保存、笔记本选择、附件开关、手动/每小时/每天任务、持久化任务与租约、增量检查点、幂等来源映射、本地编辑冲突副本、暂停/恢复/断开连接和 ENML 基础转换。

真实印象笔记生产 Key、真实账号授权、共享/企业笔记本细粒度权限和真实附件下载仍需外部联调，不能用 Mock 测试替代。当前仓库未执行生产部署。
