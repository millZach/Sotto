import React, { forwardRef, type SelectHTMLAttributes } from 'react'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', children, ...props }, ref) {
    return (
      <select {...props} ref={ref} className={`tt-select tt-focusable ${className}`.trim()}>
        {children}
      </select>
    )
  },
)
