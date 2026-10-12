import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { masterDataApi } from '@client/src/api';
import type { Customer, CustomerContact } from '@shared/api.interface';

const contactSchema = z.object({
  name: z.string().min(1, '联系人姓名不能为空'),
  phone: z.string(),
  email: z.string(),
  position: z.string(),
});

type ContactFormData = z.infer<typeof contactSchema>;

interface ContactsDialogProps {
  customer: Customer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

const ContactsDialog: React.FC<ContactsDialogProps> = ({
  customer,
  open,
  onOpenChange,
  onChanged,
}) => {
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const form = useForm<ContactFormData>({
    resolver: zodResolver(contactSchema),
    defaultValues: { name: '', phone: '', email: '', position: '' },
  });

  const load = async () => {
    if (!customer) return;
    setLoading(true);
    setError(null);
    try {
      setContacts(await masterDataApi.listContacts(customer.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载联系人失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && customer) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customer?.id]);

  const openCreate = () => {
    form.reset({ name: '', phone: '', email: '', position: '' });
    setFormOpen(true);
  };

  const onSubmit = form.handleSubmit(async (data) => {
    if (!customer) return;
    try {
      await masterDataApi.createContact(customer.id, data);
      toast.success('联系人已添加');
      setFormOpen(false);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加联系人失败');
    }
  });

  const setPrimary = async (contact: CustomerContact) => {
    try {
      await masterDataApi.updateContact(contact.id, { isPrimary: true });
      toast.success('已设为主联系人');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置失败');
    }
  };

  const remove = async (contact: CustomerContact) => {
    try {
      await masterDataApi.deleteContact(contact.id);
      toast.success('联系人已删除');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const columns: TableColumnsType<CustomerContact> = [
    { title: '姓名', dataIndex: 'name', width: 120 },
    { title: '职位', dataIndex: 'position', width: 120, render: (v) => v ?? '-' },
    { title: '电话', dataIndex: 'phone', width: 140, render: (v) => v ?? '-' },
    { title: '邮箱', dataIndex: 'email', width: 180, render: (v) => v ?? '-' },
    {
      title: '主联系人',
      dataIndex: 'isPrimary',
      width: 100,
      render: (v: boolean) =>
        v ? <Badge variant="default">主联系人</Badge> : <Badge variant="secondary">普通</Badge>,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_, record) => (
        <div className="flex gap-2">
          {!record.isPrimary ? (
            <Button variant="ghost" size="sm" onClick={() => void setPrimary(record)}>
              设为主联系人
            </Button>
          ) : null}
          {!record.isPrimary ? (
            <Button variant="ghost" size="sm" onClick={() => void remove(record)}>
              删除
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>联系人管理 - {customer?.name}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            每个客户仅一个主联系人，删除联系人不可恢复
          </p>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            添加联系人
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Table
          columns={columns}
          dataSource={contacts}
          loading={loading}
          rowKey="id"
          scroll={{ x: 800, y: 300 }}
          pagination={false}
        />
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>添加联系人</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={onSubmit} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        姓名 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="请输入姓名" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex gap-4">
                  <FormField
                    control={form.control}
                    name="position"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>职位</FormLabel>
                        <FormControl>
                          <Input placeholder="请输入职位" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>电话</FormLabel>
                        <FormControl>
                          <Input placeholder="请输入电话" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>邮箱</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入邮箱" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="submit">保存</Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
};

export default ContactsDialog;
