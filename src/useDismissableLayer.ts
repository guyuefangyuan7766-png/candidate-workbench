import { useEffect, type RefObject } from "react";

export interface DismissableLayerOptions {
  /** 弹层是否打开；关闭时自动解绑监听。 */
  open: boolean;
  /** 关闭回调：Esc、点击外部、表面切换都走这一条。 */
  onClose: () => void;
  /** 触发按钮所在容器；点击其内部不算「外部」，交给按钮自己 toggle。 */
  within?: RefObject<HTMLElement | null>;
  /** 更灵活的外部判定（如按类名匹配多行共用的菜单容器）。 */
  isInside?: (target: Node) => boolean;
  /** 是否在点击弹层外部时关闭，默认 true。 */
  dismissOnOutside?: boolean;
  /** 是否在 Esc 时关闭，默认 true。 */
  dismissOnEscape?: boolean;
}

/**
 * 统一弹层关闭行为：Esc、点击外部各一次，最内层弹层优先。
 * 监听挂在 document 捕获阶段，先于 window 上的全局 Esc 处理，避免一次 Esc 关掉两层。
 */
export function useDismissableLayer(options: DismissableLayerOptions): void {
  const { open, onClose, within, isInside, dismissOnOutside = true, dismissOnEscape = true } = options;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (isInside?.(target)) return;
      if (within?.current && within.current.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    if (dismissOnOutside) document.addEventListener("pointerdown", handlePointerDown, true);
    if (dismissOnEscape) document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [dismissOnEscape, dismissOnOutside, isInside, onClose, open, within]);
}
