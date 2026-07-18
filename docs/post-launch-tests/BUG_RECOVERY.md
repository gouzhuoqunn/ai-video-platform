# 故障恢复

1. 先确认并清理 Clore 订单，再处理本地页面或任务。
2. 保留已接受媒体；从 `nextSegmentIndex` 恢复，不能重新生成已接受的 segment 0。
3. review 接受是幂等的；重复请求应读取已有接受结果。
4. SSH 只使用按订单隔离的 known-hosts 文件；不要为代理复用修改全局 `known_hosts`。
5. 检查任务、媒体和本地日志后再重试；没有新的明确决定不得创建第二个付费订单。
6. Clore 下单公钥只能由规范私钥通过 `ssh-keygen -y` 派生；下单前必须验证公钥指纹与 SSH 私钥指纹一致。
7. SSH、SCP、Runtime 和清理必须复用同一 canonical identity、订单级 known-hosts、`IdentitiesOnly=yes` 和禁用的 SSH agent；任一组件身份不同都应停止。
8. 密码只能在该订单 payload 明确包含同一一次性 `ssh_password` 时尝试一次。密码成功后只用于修复 canonical authorized_keys，并且必须再次通过 key-only 登录才能继续。
9. `Permission denied (publickey,password)` 要记录发生阶段。本次阶段是 workspace contract 的公钥认证拒绝；不能误写成 TCP、host-key 或泛化 SSH 故障。
