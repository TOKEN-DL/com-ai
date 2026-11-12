# FLUX 3 API Prompts

## Quickstart

```bash
curl -X POST https://api.example.invalid/v1/flux3 \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat"}'
```

## Prompt Library

### 🌟 Featured Photorealistic Prompts

#### 1. Studio Portrait
```
A hyperrealistic close-up portrait of an elderly craftsman with weathered
hands, deep wrinkles, and kind eyes, shot in a wood workshop with warm
tungsten backlight, shallow depth of field, 85mm lens look, skin texture
and pore-level detail, no retouching artifacts.
```
- **Best for:** `flux-3-text-to-image`
- **Aspect Ratio:** `4:3`

#### 2. Product Hero Shot
```
A premium aluminium sports drink can on wet black acrylic, cold condensation
beads, hard rim light from the left, crisp reflections, studio macro look.
```
- **Best for:** `flux-3-text-to-image`
- **Aspect Ratio:** `16:9`

### 🎬 Video with Native Audio

#### 3. Slow Pour
```
Slow-motion macro shot of amber liquid pouring into a crystal glass, rising
bubbles, warm backlight, native audio of the pour and soft room tone.
```
- **Best for:** `flux-3-image-to-video`
- **Aspect Ratio:** `9:16`

## Tips & Best Practices

Use short, concrete nouns.
