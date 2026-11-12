import type { Mark } from '../marks/marks';

export type NodeTone = 'center' | 'added' | 'removed' | 'modified' | 'moved' | 'neighbor' | 'test';
/** cycle 为循环依赖，layer 为跨层调用（模块图用） */
export type EdgeTone = 'normal' | 'added' | 'removed' | 'cycle' | 'layer';

/** 图上的一个节点（结构图和邻居图共用） */
export interface GraphNodeSpec {
  id: string;
  label: string;
  sublabel?: string;
  tone: NodeTone;
  badge?: string;
  title?: string;
  /** 布局中的列号（从左到右），不给时由布局算法决定 */
  column?: number;
  /** 渲染为节点元素上的 `data-*` 属性 */
  attrs?: Record<string, string>;
  /** 类型标记（接口 / 模型 / 方法），显示在名字右边；接口的方法和路径放进节点的悬停提示 */
  marks?: Mark[];
  /** 名字右边的简短文字标签（如模块的外部依赖类别） */
  tags?: { label: string; title: string }[];
  onExpand?: () => void;
  /** 展开后下一层超过一页时，节点里显示的翻页按钮 */
  pager?: NodePager;
}

export interface NodePager {
  /** 从 0 开始 */
  page: number;
  pages: number;
  total: number;
  onPage(page: number): void;
}

export interface GraphEdgeSpec {
  id: string;
  source: string;
  target: string;
  tone: EdgeTone;
  /** 线宽，不给时按 tone 的默认值 */
  width?: number;
  /** 渲染为边元素上的 `data-*` 属性 */
  attrs?: Record<string, string>;
}

export const NODE_WIDTH = 230;
export const NODE_HEIGHT = 58;
