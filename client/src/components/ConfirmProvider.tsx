import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@client/src/components/ui/alert-dialog';
import { requestConfirm, setConfirmImpl } from './confirm-bridge';

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
}

type ConfirmApi = (
  description: string,
  options?: ConfirmOptions
) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmApi | null>(null);

interface Pending {
  description: string;
  title: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback<ConfirmApi>((description, options) => {
    return new Promise<boolean>((resolve) => {
      setPending({
        description,
        title: options?.title ?? '确认操作',
        confirmLabel: options?.confirmLabel ?? '确认',
        resolve,
      });
    });
  }, []);

  useEffect(() => {
    setConfirmImpl(confirm);
    return () => {
      setConfirmImpl((description) =>
        Promise.resolve(window.confirm(description))
      );
    };
  }, [confirm]);

  const close = (ok: boolean) => {
    pendingRef.current?.resolve(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={pending != null}
        onOpenChange={(open) => {
          if (!open) close(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => close(true)}
            >
              {pending?.confirmLabel ?? '确认'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

/** P0：危险操作二次确认 */
export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    return (description, options) =>
      requestConfirm(description, options);
  }
  return ctx;
}
