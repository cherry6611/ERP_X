---
name: react-hook-best-practices
description: "在编写 React Hooks 时遇到闭包陷阱、冗余 Effect、派生状态管理等问题时使用。涵盖 React 19 的 use()、useActionState、useOptimistic 等新特性，以及依赖数组管理、事件处理 vs Effect 等现代模式。React Hooks best practices for stale closures, redundant Effects, and derived state."
steering: true
steering-topic: react_hook_best_practices
match-template-name: nestjs-react-fullstack
---

# React Hook 最佳实践 (React 19+)

## ⚡️ 核心原则 (TL;DR)

1.  **优先 React 19 新特性**: 用 `use()` 读取异步数据，用 `useActionState` 管理表单，替代繁琐的 `useEffect` + `useState`。
2.  **拒绝冗余 State**: 能计算得到的变量（派生状态），绝不存入 State，直接计算 or `useMemo`。
3.  **事件驱动 > Effects**: 用户交互（点击、提交）产生的逻辑写在事件处理函数中，`useEffect` 仅用于同步外部系统（订阅、DOM）。
4.  **依赖诚实**: `useEffect/useCallback/useMemo` 的依赖数组必须包含所有引用的响应式变量，禁止欺骗 Linter。

---

## 🚫 关键禁忌与陷阱 (Critical Anti-Patterns)

| ❌ 错误模式                       | ✅ 正确做法                       | 说明                                                                                                  |
| --------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **依赖数组撒谎**                  | **诚实的依赖数组**                | 漏写依赖会导致闭包陷阱（读到旧值）。若不希望频繁触发，用 `useRef` 或拆分逻辑。                        |
| **useEffect 获取数据**            | **use() / useActionState**        | React 19 中，数据获取应配合 Suspense 或 Action，而非手动管理 loading/error。                          |
| **useCallback 依赖 loading**      | **Functional Updates / 移除依赖** | 若 `useCallback` 修改 `loading` 又依赖 `loading`，会导致引用不稳定，触发 `useEffect` 循环或双重请求。 |
| **useEffect 同步 Props 到 State** | **派生状态 / key**                | 直接在 Render 中计算；若需重置状态，给组件加 `key` prop。                                             |
| **useEffect 回调直接 async**      | **内部定义 async 函数**           | `useEffect(async () => ...)` 返回 Promise 会破坏清理机制。                                            |
| **手动管理 Form Loading**         | **useActionState**                | 自动处理 pending/error，减少样板代码。                                                                |
| **遗漏副作用清理**                | **返回清理函数**                  | 监听器、定时器、订阅必须在 `return () => ...` 中清除。                                                |

#### Safe Destructuring (安全解构)

**禁止**对可能为空的 Hook 返回值（如 `useActionState` 的 state 或 `use` 读取的异步数据）直接进行深层解构。

```typescript
// ❌ Anti-pattern
const [state, action] = useActionState(updateUser, null);
const {
  data: { name },
} = state; // 如果 state 初始为 null，直接崩溃

// ✅ Best Practice
const [state, action] = useActionState(updateUser, null);
const name = state?.data?.name ?? "Guest";
```

---

## 🆕 React 19 现代 Hooks 速查

| Hook               | 场景                   | 示例模式                                                       |
| ------------------ | ---------------------- | -------------------------------------------------------------- |
| **use(Promise)**   | **读取异步数据**       | `const data = use(fetchData(id))` (需配合 `<Suspense>`)        |
| **useActionState** | **表单提交/Mutation**  | `const [state, action, isPending] = useActionState(fn, null)`  |
| **useOptimistic**  | **乐观 UI 更新**       | `const [optTodos, addOpt] = useOptimistic(todos, reducer)`     |
| **useFormStatus**  | **子组件获取表单状态** | `const { pending } = useFormStatus()` (仅限 `<form>` 内部组件) |
| **useTransition**  | **非阻塞 UI 更新**     | `startTransition(() => setFilter(value))`                      |

### 代码对比：异步数据获取

**🔴 旧模式 (React 18-)**:

```typescript
const [data, setData] = useState(null);
const [loading, setLoading] = useState(true);
useEffect(() => {
  fetch(`/api/user/${id}`).then(d => { setData(d); setLoading(false); });
}, [id]);
if (loading) return <Spinner />;
```

**🟢 新模式 (React 19+)**:

```typescript
// 结合 Suspense 使用
const data = use(fetchUserPromise(id)); // 支持条件调用！
return <div>{data.name}</div>;
```

---

## 🧠 思维模型：State vs Effect

### 1. 派生状态 (Derived State)

**规则**: 如果一个值可以由现有的 props 或 state 计算得出，**不要**把它放入 state。

- ❌ `const [fullName, setFullName] = useState('')` + `useEffect` 更新
- ✅ `const fullName = ${firstName} ${lastName}`
- ✅ (昂贵计算) `const list = useMemo(() => sort(items), [items])`

### 2. Effect 的正确归宿

`useEffect` 是用来**同步** React 之外的东西（非 React 组件状态）的。

- **用户点击加载数据?** -> ❌ Effect -> ✅ Event Handler (`onClick`)
- **表单提交?** -> ❌ Effect -> ✅ `useActionState` / Event Handler
- **WebSocket 连接?** -> ✅ `useEffect` (因为要保持连接同步)
- **DOM 元素测量?** -> ✅ `useLayoutEffect` / `useEffect`

---

## ✅ 代码审查清单 (Checklist)

在提交代码前，请自查：

- [ ] **Hooks 规则**: 顶层调用，不嵌套在循环/条件中（`use()` 除外）。
- [ ] **依赖数组**: `useEffect`, `useMemo`, `useCallback` 包含所有外部变量。
- [ ] **清理工作**: `useEffect` 中是否清理了定时器/订阅？
- [ ] **竞态处理**: 异步 Effect 是否处理了组件卸载或 id 变更的情况？(如 `ignore` 标志)。
- [ ] **引用稳定**: `Context` value 或自定义 Hook 返回的对象，是否做了 `useMemo` 缓存？
- [ ] **React 19 升级**: 是否还在手动写 `loading` state？能否用 `useActionState` 或 `Suspense` 替代？
