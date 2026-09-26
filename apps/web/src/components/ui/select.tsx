import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Native select, styled. Deliberately native: role and status pickers sit inside dense
 * admin tables, and a native control is keyboard- and screen-reader-correct by default.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn('h-8 rounded-md border border-border bg-surface px-2 text-sm text-foreground disabled:opacity-60', className)}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
