# 当前基线

- 分支：`codex/stage4g1-long-video-prompts`；Stage 4I 开始时 HEAD：`34262c7a963c3f9831c0ccfed2080b614a9f513a`。
- 历史长视频项目：`8fff4d9f-39f6-4aee-a02a-d0a6376e4f8b`，状态 failed/retryable，`nextSegmentIndex=1`。
- segment 0 已接受并保留；PNG 尾帧 SHA-256：`d5d2bccdfa9839e6f420920d6f0ec64482dd1021004c60ad97610e76f3100f77`。segment 1/2 没有尝试，禁止重新生成 segment 0。
- 已验证 RTX 4090：UltraReal image 1024×1024；Wan Remix video 832×480、33 帧、16fps。运行时 Torch 2.6.0+cu124、Triton 3.2.0、CUDA 12.4。
- 当前模型 revision：`civitai-1413133-file-1320644`、`civitai-2770795-2771407-v3`。
- 零状态预期：Clore active orders=0；RunPod Pods/Volumes=0/0；provider holds=true；无 watcher/watchdog/create lock；无活动授权。
