# RTX 5090 单次验收提示词

下面四组提示词可直接使用。主体始终是同一位成年女性摄影师，使用合成场景，不含品牌或版权角色；seed、负面提示词和档位已给出。

## 1. 中等图片 · 1536×1024 · RTX 5090

- seed：`50901001`
- profile：`medium_image_5090`，generation=`1536x1024`，final=`1536x1024`
- prompt：`An adult woman landscape photographer in a rust-red jacket stands beside a quiet alpine lake at sunrise, wind moving loose hair and jacket fabric, slow natural breathing, cinematic documentary still, detailed water reflections, soft golden rim light, coherent hands and face, synthetic subject, no logos or brands.`
- negative：`child, teen, minor, celebrity, copyrighted character, brand logo, watermark, text, extra fingers, malformed hands, duplicate person, blur, low resolution, oversaturated skin`

## 2. 高质量图片 · 2048×2048 最终尺寸 · RTX 5090

- seed：`50901002`
- profile：`high_image_5090`，generation=`1536x1536`，final=`2048x2048`，strategy=`upscale_or_refinement_expected`
- prompt：`The same adult woman landscape photographer adjusts a vintage tripod on a misty mountain ridge, scarf and hair moving in a clear breeze, focused expression, square editorial portrait, realistic fabric and skin texture, natural sunrise color, synthetic subject, no logos or brands.`
- negative：`child, teen, minor, celebrity, copyrighted character, brand logo, watermark, text, extra limbs, bad anatomy, duplicate subject, plastic skin, compression artifacts`

## 3. 中等长视频 · 720P · 10 秒两段

- seed：`50902001`; profile：`medium_video_5090`; generation=`1280x720`; final=`1280x720`; segments=`2 x 5s`
- first-frame prompt：`The same adult woman landscape photographer beside the alpine lake, red jacket, tripod visible, sunrise mist, stable camera, synthetic subject, no brands.`
- segment 1 (`1-5s`)：`She raises the camera, turns slightly toward the lake, and the breeze moves her hair and jacket while the tripod remains fixed; slow gentle dolly-in, preserve face and clothing continuity.`
- segment 2 (`6-10s`)：`Continue from the exact pose and lake composition; she takes one photograph, lowers the camera, and smiles subtly as mist drifts left; match the previous segment tail frame and lighting.`
- negative：`child, teen, minor, celebrity, copyrighted character, logo, watermark, text, flicker, hard cuts, identity drift, extra fingers, warped tripod, duplicate subject, camera shake`

## 4. 高质量长视频 · 1080P 最终输出 · 10 秒两段

- seed：`50902002`; profile：`high_video_5090`; generation=`1280x720`; final=`1920x1080`; strategy=`upscale_or_refinement_expected`
- first-frame prompt：`The same adult woman landscape photographer at the alpine lake, rust-red jacket, tripod and calm reflective water, cinematic sunrise, synthetic subject, no logos.`
- segment 1 (`1-5s`)：`She walks two small steps toward the tripod, raises the camera, and wind moves her hair and jacket; keep a smooth lateral camera move and stable identity.`
- segment 2 (`6-10s`)：`Continue from the last frame; she presses the shutter, lowers the camera, and looks across the lake while the same mist and sunrise persist; exact tail-frame continuity, smooth motion.`
- negative：`child, teen, minor, celebrity, copyrighted character, logo, watermark, text, scene discontinuity, identity drift, flicker, extra limbs, malformed hands, warped horizon, unstable exposure`
