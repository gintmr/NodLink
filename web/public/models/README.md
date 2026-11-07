# 3D 模型

默认角色是程序建模的 Q 版小机器人 NodBot（`ui/pet.js`），不用模型文件。下面三个模型文件还在仓库里，但已经不出现在角色列表里。

| 文件 | 内容 | 作者 | 授权 |
|---|---|---|---|
| `robot.glb` | 卡通机器人（RobotExpressive） | [Tomás Laulhé（Quaternius）](https://www.patreon.com/quaternius)，Don McCurdy 修改；来自 [three.js 仓库](https://github.com/mrdoob/three.js/tree/r170/examples/models/gltf/RobotExpressive) | CC0 1.0 |

| `kaykit-knight.glb` | 骑士（KayKit Adventurers：Knight） | [Kay Lousberg](https://www.kaylousberg.com)；来自 [KayKit-Character-Pack-Adventures-1.0](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) | CC0 1.0 |
| `kaykit-mage.glb` | 法师（KayKit Adventurers：Mage） | 同上 | CC0 1.0 |

KayKit 角色手里的剑、盾、法杖在加载时去掉（`ui/scene3d.js` 的 `PROP_NAMES`）；它们没有点头、摇头动画，用自带的 `Cheer`、`Hit_A`、`Interact` 代替（`CLIP_ALIASES`）。

| `room/white_home_studio_1k.hdr` | 第三人称 3D 场景的环境光 | [Poly Haven](https://polyhaven.com) | CC0 1.0 |

第三人称场景里的书桌、地毯、显示器、键盘、AirPods 充电盒、手机、耳机、飞机模型、吊灯、零食和饮料都是 `ui/scene3d.js` 里程序建模的；第一人称的像素插画在 `ui/pixel-desk.js` 里逐像素画出。都没有外部模型文件。

这个文件夹里的其他 `.glb` / `.gltf` 文件会出现在调试台的模型列表里，但不会提交到仓库（见根目录 `.gitignore`）。请只放有授权的模型。
