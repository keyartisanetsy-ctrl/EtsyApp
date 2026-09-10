import React from 'react';

/** Standard page frame: fixed top bar, scrolling content. */
export default function Page({ title, subtitle, actions, children, flush }) {
  return (
    <>
      <header className="topbar">
        <h1>{title}</h1>
        {subtitle && <span className="sub">{subtitle}</span>}
        <div className="spacer" />
        {actions}
      </header>
      <div className={`content ${flush ? 'flush' : ''}`}>{children}</div>
    </>
  );
}

/** Frame for the full-height table screens: toolbar, scroll body, pager. */
export function TablePage({ title, subtitle, actions, toolbar, selection, children, pager }) {
  return (
    <>
      <header className="topbar">
        <h1>{title}</h1>
        {subtitle && <span className="sub">{subtitle}</span>}
        <div className="spacer" />
        {actions}
      </header>
      {toolbar && <div className="toolbar">{toolbar}</div>}
      {selection}
      <div className="table-wrap">{children}</div>
      {pager}
    </>
  );
}
