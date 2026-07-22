# DOOM 覆盖层演示

在 pi 中以覆盖层运行 DOOM。演示覆盖层系统如何以 35 FPS 处理实时游戏渲染。

## 用法

```bash
pi --extension ./examples/extensions/doom-overlay
```

然后运行：
```
/doom-overlay
```

共享版 WAD 文件（约 4MB）会在首次运行时自动下载。

## 操作

| 操作 | 按键 |
|--------|------|
| Move | WASD or Arrow Keys |
| Run | Shift + WASD |
| Fire | F or Ctrl |
| Use/Open | Space |
| Weapons | 1-7 |
| Map | Tab |
| Menu | Escape |
| Pause/Quit | Q |

## 工作原理

DOOM 以由 [doomgeneric](https://github.com/ozkl/doomgeneric) 编译得到的 WebAssembly 运行。每一帧使用带 24 位颜色的半块字符（▀）渲染：上方像素使用前景色，下方像素使用背景色。

覆盖层使用：
- `width: "90%"` - 90% of terminal width
- `maxHeight: "80%"` - Maximum 80% of terminal height
- `anchor: "center"` - Centered in terminal

高度根据宽度计算，以保持 DOOM 的 3.2:1 宽高比（同时考虑半块字符渲染）。

## 致谢

- [id Software](https://github.com/id-Software/DOOM) for the original DOOM
- [doomgeneric](https://github.com/ozkl/doomgeneric) for the portable DOOM implementation
- [pi-doom](https://github.com/badlogic/pi-doom) for the original pi integration
