import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@client/src/components/ui/popover';
import { Button } from '@client/src/components/ui/button';
import { Calendar } from '@client/src/components/ui/calendar';
import { FormControl } from '@client/src/components/ui/form';

interface DateFieldProps {
  value: string | null | undefined;
  onChange: (value: string | undefined) => void;
}

const toLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const DateField: React.FC<DateFieldProps> = ({ value, onChange }) => (
  <Popover>
    <PopoverTrigger asChild>
      <FormControl>
        <Button variant="outline" className="w-full justify-start font-normal" type="button">
          {value ? value : '请选择日期'}
        </Button>
      </FormControl>
    </PopoverTrigger>
    <PopoverContent className="w-auto p-0" align="start">
      <Calendar
        mode="single"
        selected={value ? new Date(`${value}T00:00:00`) : undefined}
        onSelect={(date: Date | undefined) => onChange(date ? toLocalDate(date) : undefined)}
      />
    </PopoverContent>
  </Popover>
);

export default DateField;
