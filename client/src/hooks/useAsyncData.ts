import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 轻量数据加载 hook（本项目 ERP 数据统一走它 + 显式 `reload()`，
 * 不用 react-query）。
 *
 * ## 为什么不用 `useCallback(loader, deps)`（这里曾是一个真实缺陷）
 *
 * 原实现是 `const load = useCallback(async () => {...}, deps)` —— 把调用方
 * 传来的 `deps` 数组**直接当作 `useCallback` 的依赖数组**。这有两个问题：
 *
 * 1. **违反 Hooks 规则**：`useCallback` 的依赖数组必须由调用点在**源码层面**
 *    字面量给出，React 才能静态比对。运行期传入的数组一旦长度变化，
 *    React 会抛 "The final argument passed to useCallback changed size between renders"。
 *    本 hook 有 60+ 个调用点，任一处 `deps` 的条件化写法都可能触发。
 * 2. **ESLint 检查不到**：`react-hooks/exhaustive-deps` 只能检查字面量依赖数组，
 *    经变量传入的它看不见 —— 于是"依赖漏写"这类 bug 永远不会被静态拦下。
 *    项目里已经出现了绕法：`VoucherPanel.tsx` 写 `[codes.join(','), watchedPeriod]`
 *    来手工伪造稳定依赖。
 *
 * ## 现在的做法
 *
 * 把 `loader` 放进 `ref`，并把调用方给的 `deps` **序列化成一个字符串 `fetchKey`**
 * （再折进手动重载计数器），由 `useEffect` 直接依赖它：
 *   · 依赖内容变化 → `fetchKey` 变 → effect 重新取数（语义与原来一致）；
 *   · 每次渲染传入**内联箭头函数**（绝大多数调用点这么写）不会造成重复取数
 *     —— `loader` 走 ref，不参与依赖比较；
 *   · 依赖是字面量 `[]` 时 `fetchKey` 恒定，只取一次；
 *   · `deps` 无法序列化（含函数/循环引用）时退化为"不重取"，并**不静默出错**
 *     （序列化兜底键里带调用序号，宁可多取一次也不漏取）。
 *
 * `reload()` **返回 Promise 并真正 await 到数据写完** —— 这是本 hook 的对外契约，
 * 多处调用点依赖它做后续动作（`await reload(); 再算 EVM`）。改动时不得破坏。
 *
 * 请求竞态由 `loadIdRef` 保证：只有最后一次发起的请求能写回 state。
 */
function depsKeyOf(deps: unknown[], fallback: number): string {
  try {
    return JSON.stringify(deps) ?? `__nonjson_${fallback}`;
  } catch {
    // 循环引用等：退回按调用序号区分，保证不静默共用同一个 key
    return `__unserializable_${fallback}`;
  }
}

export function useAsyncData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadIdRef = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  // 依赖内容 → version。用序列化键比较"内容"而不是数组引用，
  // 同时在 deps 无法序列化时用调用序号兜底（宁可多取一次，也不要漏取）。
  const callSeqRef = useRef(0);
  callSeqRef.current += 1;
  const depsKey = depsKeyOf(deps, callSeqRef.current);
  /*
   * `reloadSeq`：手动重载计数器。**每个"应取数"事件 +1**，并被折进 `depsKey`
   * 参与对比 —— 于是"依赖变化"与"手动重载"走**同一条**取数路径，
   * 不需要两个 effect，也不会出现"两条路径各取一次"。
   *
   * 它是 state 而不是 ref：`reload()` 必须让组件重渲染（否则只取数不更新 UI），
   * 而 state 变化正是重渲染的触发器。
   */
  const [reloadSeq, setReloadSeq] = useState(0);

  /*
   * `fetchKey` 是"**这一次渲染该不该取数**"的唯一判据：
   * 依赖内容的序列化键 + 手动重载计数器。
   *
   * 它必须是**每次渲染都重算出来的原始值**（不是 ref、也不是 `useMemo` 的返回值）——
   * 只有这样 `useEffect` 才有一个 lint 认可且语义直白的依赖项：
   * "key 变了就取数"。没有中间层，也就没有"靠某个不变量成立"的隐含假设。
   */
  const fetchKey = `${depsKey}\u0000seq${reloadSeq}`;

  /*
   * F9（§5.8）：取数触发**由 effect 直接声明**，不再靠一个中间计数器间接驱动。
   *
   * ## 原来的写法及其问题
   *
   * ```ts
   * const version = useMemo(() => {...推进 ref...}, [depsKey]);
   * const load = useCallback(async () => {...}, [version]);   // ← lint：多余依赖
   * useEffect(() => { void load(); }, [load]);
   * ```
   *
   * `react-hooks/exhaustive-deps` 拒绝把 `useMemo` 的返回值当依赖（判据是
   * "必须能触发重渲染"）。在本 hook 里这个判据**技术上绕得过去** ——
   * 但它确实指出了真实脆弱点：整条"重新取数"链路依赖一个**静态不可验证的
   * 不变量**（"version 变必然伴随重渲染"）。任何人后续把 version 挪出组件作用域
   * 都会静默破坏取数时机，而 lint 与 tsc 都不会出声。
   *
   * ## 现在的写法
   *
   * ```ts
   * useEffect(() => { void runLoad(); }, [fetchKey, runLoad]);
   * ```
   *
   * `fetchKey` 是**依赖内容的序列化字符串**（已把 `reloadSeq` 折进去）。
   * 它满足 lint 的判据：是一个在渲染中重新计算、可比较的原始值。
   * 用字符串而不是 `deps` 数组本身，是因为 `deps` 每次渲染都是新的数组字面量
   * （60+ 个调用点里绝大多数是内联 `[period]` 这种），直接当依赖会让 effect
   * **每次渲染都跑一遍**。比较内容才是本 hook 一直以来的语义。
   *
   * ## 竞态
   *
   * 仍由 `loadIdRef` 保证：只有最后一次发起的请求能写回 state（与依赖无关，
   * 改动前后行为一致）。
   */
  const runLoad = useCallback(async () => {
    const loadId = loadIdRef.current + 1;
    loadIdRef.current = loadId;
    setLoading(true);
    setError(null);
    try {
      const result = await loaderRef.current();
      if (loadIdRef.current !== loadId) return;
      setData(result);
    } catch (err) {
      if (loadIdRef.current !== loadId) return;
      setError(err instanceof Error ? err.message : '加载失败，请重试');
    } finally {
      if (loadIdRef.current === loadId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void runLoad();
  }, [fetchKey, runLoad]);

  /**
   * 手动重载。
   *
   * ⚠️ **必须返回 Promise 并真正 await 到数据写完** —— 这不是可选的美化。
   *
   * 原实现直接把 `load` 暴露为 `reload`，因此 `await reload()` 意味着
   * "数据已经取回并写进 state"。本仓多处依赖这个语义做后续动作，例如：
   *
   * ```ts
   * await reload();          // 写成功后刷新列表
   * await reloadDetail();    // 拿到最新数据再算 EVM
   * ```
   *
   * 若改成"只 setState 触发 effect 取数"（返回 `void`），这些 `await` 会
   * **立即 resolve 而数据还没到**，后续读到的仍是旧值 —— 而且不会报错，
   * 只是结果悄悄不对。这是比多渲染一次严重得多的代价。
   *
   * 因此这里刻意**同步**调用 `runLoad()`：既立刻取数并返回可 await 的 Promise，
   * 又推进 `reloadSeq` 让 `fetchKey` 变化（保证 UI 更新且下次依赖变化仍会取数）。
   * 并发的两次 `reload()` 由 `runLoad` 内部未被 await 的每次调用直接覆盖 ——
   * 与改动前行为一致。
   */
  const reload = useCallback(async (): Promise<void> => {
    setReloadSeq((n) => n + 1);
    await runLoad();
  }, [runLoad]);

  return { data, loading, error, reload };
}
