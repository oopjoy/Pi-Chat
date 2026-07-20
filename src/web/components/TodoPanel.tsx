import type { TodoItem } from "../../shared/types";

export function TodoPanel({ todos, collapsed, onToggle }: { todos: TodoItem[]; collapsed: boolean; onToggle: () => void }) {
  const completed = todos.filter((todo) => todo.done).length;
  return <aside className={`todo-panel ${collapsed ? "is-collapsed" : ""}`} aria-label="当前对话待办清单">
    <header>
      <button type="button" className="todo-panel-title" onClick={onToggle} title={collapsed ? "展开待办清单" : "收起待办清单"} aria-expanded={!collapsed}>待办清单</button>
      {!collapsed && todos.length > 0 && <small>{completed}/{todos.length}</small>}
    </header>
    {!collapsed && (todos.length ? <ul>
      {todos.map((todo) => <li key={todo.id} className={todo.done ? "is-done" : ""}>
        <span className="todo-check" aria-label={todo.done ? "已完成" : "未完成"}>{todo.done && "✓"}</span>
        <span title={todo.text}>{todo.text}</span>
      </li>)}
    </ul> : <p className="todo-empty">暂无待办</p>)}
  </aside>;
}
