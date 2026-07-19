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
10. 远程推理不得依赖一个一直打开的 SSH shell 返回最终 JSON。启动命令必须记录真实 PID，并把 stdin/stdout/stderr 全部从父 SSH 通道重定向。
11. 远程结果顺序固定为：原子写 `result.json`、原子写 exit code、原子写 terminal marker；短状态命令只返回一次可解析完成哨兵，JSON 必须由单独的有界命令读取。
12. 如果 terminal marker 已存在但本地读取 JSON 中断，保留 job 目录。用同一个 durable attempt UUID 重入时只读取原结果，不能创建新尝试或再次提交推理。
13. 空状态响应、非零远程退出、结果读取中断和有界超时是四种不同错误，不能都折叠为 `invalid_runner_json`。
14. 恢复循环从 `nextSegmentIndex` 开始；已接受 segment 直接跳过。`generating` segment 若已有 `running` attempt，必须复用该 attempt ID。

## Stage 4J.7 restore-throughput recovery

15. A slow but error-free restore must not be relabeled as a Wan, Blackwell, R2-integrity, SSH, or Runtime failure. Stage 4J.6 is classified exactly as `restore_throughput_incompatible_with_previous_session_deadline`.
16. Run the bounded actual presigned read-only R2 model-source probe before restore. A generic public speed test is not evidence for the model route.
17. If Range/206 validation or the dynamic time/cost gate fails before restore, cancel that candidate. One different qualification candidate may be tried only when a new explicit paid authorization permits it.
18. After any production restore starts or any inference is submitted, do not create a replacement order.
19. Resume chunk `.part` files only at their exact non-overlapping range boundaries. Publish a restored object only after exact size and full SHA-256 pass; delete corrupt assembled/chunk state.
20. Preserve both accepted images, accepted segment 0, its MP4 and last-frame hashes, and segment-1 attempts `0`. Throughput recovery must never regenerate those assets.
