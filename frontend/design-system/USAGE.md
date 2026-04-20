# Perda Design System v2.0

A production-grade, scalable visual system for the Perda SaaS platform.

---

## Quick Reference

### CSS Variable Usage

```css
/* Use in any component */
background: var(--bg-elevated);
color: var(--text-primary);
border: 1px solid var(--border-default);
border-radius: var(--radius-lg);
box-shadow: var(--shadow-card);
transition: all var(--duration-normal) var(--ease-smooth);
```

### Tailwind Classes

```tsx
// Background layers
<div className="bg-[var(--bg-base)]" />       // Deepest
<div className="bg-[var(--bg-secondary)]" />   // Sidebar/panels
<div className="bg-[var(--bg-elevated)]" />    // Cards
<div className="bg-[var(--bg-surface)]" />     // Hover/surface

// Using the brand color scale
<button className="bg-brand-500 hover:bg-brand-400" />

// Typography
<h1 className="text-page-title" />
<h2 className="text-section-title" />
<p className="text-body" />
<span className="text-label" />
<span className="text-caption" />

// Shadows
<div className="shadow-card hover:shadow-card-hover" />
<div className="shadow-floating" />  // modals/dropdowns
<div className="shadow-glow" />      // focused state

// Animation
<div className="animate-fade-in" />
<div className="animate-fade-in-up" />
<div className="animate-fade-in-scale" />
<div className="transition-smooth duration-normal ease-smooth" />
```

### DS Component Classes

```tsx
// Cards
<div className="ds-card">
  <div className="ds-card-header">Title</div>
  <div className="ds-card-body">Content</div>
</div>

// Buttons
<button className="ds-btn-primary">Primary</button>
<button className="ds-btn-secondary">Secondary</button>
<button className="ds-btn-ghost">Ghost</button>
<button className="ds-btn-danger">Danger</button>
<button className="ds-btn-primary ds-btn-loading">Loading...</button>

// Inputs
<input className="ds-input" placeholder="Enter value" />
<input className="ds-input ds-input-error" />  // Error state
<select className="ds-select">...</select>
<label className="ds-label">Label Text</label>
<p className="ds-helper">Helper text</p>
<p className="ds-helper-error">Error message</p>

// Chip/Tag Input
<div className="ds-chip-input">
  <span className="ds-chip">Tag 1 <span className="ds-chip-remove">×</span></span>
  <input className="..." />
</div>

// Badges
<span className="ds-badge ds-badge-success">Active</span>
<span className="ds-badge ds-badge-error">Failed</span>
<span className="ds-badge ds-badge-warning">Pending</span>
<span className="ds-badge ds-badge-info">Running</span>
<span className="ds-badge ds-badge-neutral">Idle</span>
<span className="ds-badge ds-badge-primary">New</span>

// Status Dots
<span className="ds-dot ds-dot-success" />
<span className="ds-dot ds-dot-error ds-dot-pulse" />

// Loaders
<div className="ds-spinner" />
<div className="ds-spinner ds-spinner-sm" />
<div className="ds-spinner ds-spinner-lg" />
<div className="ds-progress">
  <div className="ds-progress-fill" style={{ width: '60%' }} />
</div>
<div className="ds-progress">
  <div className="ds-progress-fill indeterminate" />
</div>
<div className="skeleton skeleton-card" />
<div className="skeleton skeleton-text" />

// Modal
<div className="ds-modal-overlay">
  <div className="ds-modal">
    <div className="ds-modal-header">...</div>
    <div className="ds-modal-body">...</div>
    <div className="ds-modal-footer">...</div>
  </div>
</div>

// Table
<table className="ds-table">
  <thead><tr><th>Header</th></tr></thead>
  <tbody><tr><td>Cell</td></tr></tbody>
</table>

// Typography
<h1 className="ds-page-title">Page Title</h1>
<p className="ds-page-subtitle">Description</p>
<h3 className="ds-section-title">SECTION LABEL</h3>

// Divider
<hr className="ds-divider" />

// Utilities
<div className="hover-lift">Lifts on hover</div>
<div className="hover-scale">Scales on hover</div>
<div className="hover-glow">Glows on hover</div>
<div className="stagger-item">Animates in sequence</div>
```

---

## Architecture

```
design-system/
  tokens.json          ← All raw design tokens (JSON)
app/
  globals.css          ← Design system implementation
  layout.tsx           ← Font loading + theme setup
tailwind.config.ts     ← Extended Tailwind with tokens
```

---

## Rules

1. **Always use CSS variables** for colors, not raw hex values
2. **Use `ds-*` classes** for common components (cards, buttons, inputs)
3. **Spacing: use Tailwind's scale** (p-4 = 16px, p-5 = 20px, p-6 = 24px)
4. **Border radius: use `rounded-sm/md/lg/xl`** from the config
5. **Shadows: use `shadow-card/floating/glow`** from the config
6. **Animations: use named animations** or `transition-smooth duration-normal`
7. **Light theme: just toggle `html.light` class** — all vars auto-switch
