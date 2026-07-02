/**
 * 可读会话 ID 的单词表
 *
 * 为 YYMMDD-adjective-noun 这种格式提供形容词和名词，
 * 目的是生成好记、URL 安全的会话标识符。
 */

/**
 * 形容词：短、正面/中性、易拼写。
 * 约 100 个词，保证每天有足够组合。
 */
export const ADJECTIVES = [
  // Nature/Weather
  'bright', 'calm', 'clear', 'cool', 'crisp', 'fresh', 'gentle', 'golden', 'misty', 'sunny',
  'warm', 'wild', 'windy', 'frosty', 'mild', 'soft', 'swift', 'quiet', 'silent', 'still',

  // Colors (abstract)
  'azure', 'coral', 'amber', 'jade', 'ruby', 'ivory', 'onyx', 'pearl', 'silver', 'copper',

  // Qualities
  'bold', 'brave', 'clever', 'eager', 'fair', 'fleet', 'grand', 'keen', 'noble', 'proud',
  'quick', 'sharp', 'smart', 'steady', 'strong', 'true', 'vivid', 'wise', 'witty', 'zesty',

  // Size/Shape
  'broad', 'deep', 'high', 'long', 'tall', 'vast', 'wide', 'slim', 'lean', 'agile',

  // Texture/Feel
  'smooth', 'light', 'airy', 'sleek', 'polished', 'refined', 'pure', 'prime', 'fine', 'neat',

  // Energy/Motion
  'active', 'brisk', 'lively', 'nimble', 'rapid', 'ready', 'spry', 'vital', 'dynamic', 'fluid',

  // Time/State
  'early', 'first', 'fresh', 'new', 'prime', 'young', 'alert', 'awake', 'aware', 'focal',

  // Abstract positive
  'apt', 'deft', 'fit', 'apt', 'lucid', 'open', 'plain', 'safe', 'snug', 'tidy',
] as const;

/**
 * 名词：自然主题、具体、好记。
 * 约 200 个词（100 形容词 × 200 名词 = 每天约 2 万种组合）。
 */
export const NOUNS = [
  // Landscape
  'canyon', 'cliff', 'coast', 'cove', 'creek', 'delta', 'dune', 'field', 'fjord', 'forest',
  'glade', 'glen', 'gorge', 'grove', 'harbor', 'heath', 'hill', 'island', 'lagoon', 'lake',
  'marsh', 'meadow', 'mesa', 'moor', 'mountain', 'oasis', 'ocean', 'pass', 'peak', 'plain',
  'plateau', 'pond', 'prairie', 'ravine', 'reef', 'ridge', 'river', 'shore', 'spring', 'stream',
  'summit', 'swamp', 'trail', 'valley', 'vista', 'waterfall', 'woods', 'bay', 'beach', 'bluff',

  // Sky/Space
  'aurora', 'cloud', 'comet', 'cosmos', 'dawn', 'dusk', 'eclipse', 'galaxy', 'halo', 'horizon',
  'meteor', 'moon', 'nebula', 'nova', 'orbit', 'pulsar', 'quasar', 'rainbow', 'sky', 'star',
  'storm', 'sun', 'sunset', 'thunder', 'twilight', 'zenith', 'breeze', 'gust', 'mist', 'frost',

  // Animals
  'bear', 'crane', 'crow', 'deer', 'dove', 'eagle', 'elk', 'falcon', 'finch', 'fox',
  'hawk', 'heron', 'horse', 'lark', 'lion', 'lynx', 'otter', 'owl', 'panther', 'puma',
  'raven', 'robin', 'salmon', 'seal', 'shark', 'sparrow', 'stag', 'swan', 'tiger', 'trout',
  'whale', 'wolf', 'wren', 'badger', 'beaver', 'bison', 'bobcat', 'coyote', 'dolphin', 'gecko',

  // Plants
  'aspen', 'bamboo', 'birch', 'bloom', 'blossom', 'bonsai', 'branch', 'cedar', 'cherry', 'clover',
  'cypress', 'elm', 'fern', 'flower', 'grove', 'hazel', 'holly', 'ivy', 'jasmine', 'laurel',
  'leaf', 'lily', 'lotus', 'maple', 'moss', 'oak', 'olive', 'orchid', 'palm', 'pine',
  'poplar', 'reed', 'rose', 'sage', 'sequoia', 'spruce', 'thistle', 'tulip', 'vine', 'willow',

  // Elements/Materials
  'amber', 'bronze', 'carbon', 'chrome', 'cobalt', 'copper', 'coral', 'crystal', 'diamond', 'ember',
  'flint', 'garnet', 'gem', 'glass', 'gold', 'granite', 'iron', 'jade', 'jasper', 'marble',
  'nickel', 'obsidian', 'opal', 'pearl', 'quartz', 'ruby', 'sand', 'sapphire', 'silver', 'slate',
  'steel', 'stone', 'titanium', 'topaz', 'zinc', 'basalt', 'clay', 'cobble', 'pebble', 'boulder',

  // Water features
  'brook', 'cascade', 'channel', 'current', 'eddy', 'falls', 'flood', 'flow', 'fountain', 'geyser',
  'glacier', 'inlet', 'rapids', 'ripple', 'shoal', 'spray', 'surge', 'tide', 'torrent', 'wave',
] as const;

/**
 * 形容词类型。
 * typeof ADJECTIVES[number] 会取出数组中所有字面量值的联合类型，
 * 类似 Go 中从常量枚举得到的类型。
 */
export type Adjective = typeof ADJECTIVES[number];

/**
 * 名词类型。
 * typeof NOUNS[number] 同理。
 */
export type Noun = typeof NOUNS[number];
