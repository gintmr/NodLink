// 游戏厅里的游戏，按大厅里的顺序排。每个游戏的接口见 ui/arcade.js 开头
import sonar from './sonar.js';
import slot from './slot.js';
import beat from './beat.js';
import blade from './blade.js';
import runner from './runner.js';
import naiwa from './naiwa.js';

export const GAMES = [sonar, slot, beat, blade, runner, naiwa];
