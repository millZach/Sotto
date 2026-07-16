import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant
  readonly iconOnly?: boolean
  readonly children: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'primary',
  iconOnly = false,
  className = '',
  type = 'button',
  children,
  ...props
}, ref): ReactNode {
  if (iconOnly && !props['aria-label']) {
    throw new Error('Icon-only buttons require an aria-label.')
  }

  const classes = [
    'tt-button',
    'tt-focusable',
    `tt-button--${variant}`,
    iconOnly ? 'tt-button--icon' : '',
    className,
  ].filter(Boolean).join(' ')

  return <button ref={ref} {...props} type={type} className={classes}>{children}</button>
})
