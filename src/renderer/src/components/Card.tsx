import React, { type HTMLAttributes, type ReactNode } from 'react'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  readonly as?: 'section' | 'article' | 'div'
  readonly children: ReactNode
}

export function Card({ as: Element = 'section', className = '', children, ...props }: CardProps): ReactNode {
  return <Element {...props} className={`tt-card ${className}`.trim()}>{children}</Element>
}
