import React, {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from 'react'

export interface FieldProps {
  readonly label: string
  readonly description?: string
  readonly error?: string
  readonly children: ReactElement<Record<string, unknown>>
  readonly className?: string
}

export function Field({ label, description, error, children, className = '' }: FieldProps): ReactNode {
  const generatedId = useId()
  if (!isValidElement(children)) throw new Error('Field requires one form control.')
  const controlId = typeof children.props.id === 'string' ? children.props.id : `${generatedId}-control`
  const descriptionId = description === undefined ? undefined : `${generatedId}-description`
  const errorId = error === undefined ? undefined : `${generatedId}-error`
  const existingDescription = typeof children.props['aria-describedby'] === 'string'
    ? children.props['aria-describedby']
    : undefined
  const describedBy = [existingDescription, descriptionId, errorId].filter(Boolean).join(' ') || undefined
  const control = cloneElement(children, {
    id: controlId,
    'aria-describedby': describedBy,
    'aria-invalid': error === undefined ? children.props['aria-invalid'] : true,
    className: [
      typeof children.props.className === 'string' ? children.props.className : '',
      'tt-focusable',
    ].filter(Boolean).join(' '),
  })

  return (
    <div className={`tt-field ${className}`.trim()}>
      <label className="tt-field__label" htmlFor={controlId}>{label}</label>
      {description === undefined ? null : (
        <p className="tt-field__description" id={descriptionId}>{description}</p>
      )}
      {control}
      {error === undefined ? null : (
        <p className="tt-field__error" id={errorId}>{error}</p>
      )}
    </div>
  )
}
