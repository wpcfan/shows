# 行尸走肉视觉风格关键词 (参考词库)

> **V2 变更**:本文件为风格参考词库。`build-prompt.js` 不再自动随机注入这些关键词。
> 请在 `script.yaml` 的每个 shot 的 `style_en` 字段中手动选用关键词。
> 修改本文件不会影响已有 prompt,只影响作者编写 `style_en` 时的参考。

## palette
desaturated, muted greens, earth tones, grayish browns, washed-out contrast, low saturation, no vivid colors, cold steel grays, dried-blood rust

## lighting
harsh sunlight, overcast sky, golden hour haze, flickering fluorescent tubes, single source practical light, deep shadows, backlight through boarded windows, dust-lit beams, dusk blue hour, moonlight cold tone

## camera
handheld, documentary-style, shallow depth of field, slight camera shake, observational framing, 35mm film grain texture, slow push-in, abrupt whip pan, lingering wide shot, intentional awkward framing

## setting
urban decay, peeling paint, rust, overgrown vegetation, abandoned vehicles, fallen plaster, broken glass, scattered debris, collapsed shelving, mud-streaked floors, blood smears on walls

## mood
tense, melancholic, gritty, hopeless, dread-filled silence, oppressive stillness, moral exhaustion, survival anxiety, dread

## gore
practical effects, dried blood, viscera implied not gushing, torn clothing, visible wounds without stylization, gritty not splatter-porn, restrained horror

## pacing
slow build, sudden bursts of violence, long observational holds, abrupt cuts on impact

## audio_cue (visual proxy)
heavy breathing visible in frame, distant guttural moans suggested by character reaction, environmental silence emphasized by stillness

## injection_rule (V2 — 手动注入)
- 拼装顺序:`[shot.style_en]` + `[shot.camera]` + `shot.prompt_en` + `[角色 appearance_en]` + `[场景 appearance_en]`
- 作者从上述词库中选用关键词,写入 `script.yaml` 的 `shot.style_en` 字段
- `no_style_inject: true` 时跳过 `style_en` 和 `camera`(明亮/非末日场景用)
- 无 `style_en` 字段时不注入风格,打印 warning
