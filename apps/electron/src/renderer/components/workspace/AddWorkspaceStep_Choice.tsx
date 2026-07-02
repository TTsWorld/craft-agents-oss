import { useTranslation } from "react-i18next"
import { FolderPlus, FolderOpen, Cloud } from "lucide-react"
import { cn } from "@/lib/utils"
import { AddWorkspaceContainer, AddWorkspaceStepHeader } from "./primitives"

interface AddWorkspaceStep_ChoiceProps {
  /** 用户选择“新建工作区” */
  onCreateNew: () => void
  /** 用户选择“打开已有文件夹” */
  onOpenFolder: () => void
  /** 用户选择“连接远程服务器” */
  onConnectRemote: () => void
}

interface ChoiceCardProps {
  /** 卡片左侧图标 */
  icon: React.ReactNode
  /** 卡片标题 */
  title: string
  /** 卡片说明 */
  description: string
  /** 点击卡片触发的回调 */
  onClick: () => void
  /** 视觉变体，primary 表示推荐选项 */
  variant?: 'primary' | 'secondary'
}

/**
 * ChoiceCard - 选择步骤中的大卡片按钮
 *
 * 左侧图标、右侧标题与说明，整体作为一个 button 响应点击。
 */
function ChoiceCard({ icon, title, description, onClick, variant = 'secondary' }: ChoiceCardProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-4 w-full p-4 rounded-lg text-left",
        "bg-background shadow-minimal",
        "transition-all duration-150",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        variant === 'primary'
          ? "hover:bg-accent/5"
          : "hover:bg-foreground/5"
      )}
    >
      <div className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
        variant === 'primary'
          ? "bg-accent/10 text-accent"
          : "bg-foreground/5 text-foreground/70"
      )}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="font-medium text-[15px] text-foreground">{title}</div>
        <div className="text-[12px] text-muted-foreground -mt-[1px]">{description}</div>
      </div>
    </button>
  )
}

/**
 * AddWorkspaceStep_Choice - 添加工作区的初始选择步骤
 *
 * 提供三个入口：
 * 1. 新建工作区：在本地创建全新的工作区文件夹
 * 2. 打开已有文件夹：把本地已有文件夹作为工作区打开
 * 3. 连接远程服务器：连接到远程 Craft Agent Server 上的工作区
 */
export function AddWorkspaceStep_Choice({
  onCreateNew,
  onOpenFolder,
  onConnectRemote,
}: AddWorkspaceStep_ChoiceProps) {
  const { t } = useTranslation()
  return (
    <AddWorkspaceContainer>
      <div className="mt-2" />
      <AddWorkspaceStepHeader
        title={t("workspace.addWorkspace")}
        description={t("workspace.addWorkspaceDesc")}
      />

      <div className="mt-8 w-full space-y-3">
        <ChoiceCard
          icon={<FolderPlus className="h-5 w-5" />}
          title={t("workspace.createNew")}
          description={t("workspace.createNewDesc")}
          onClick={onCreateNew}
          variant="primary"
        />

        <ChoiceCard
          icon={<FolderOpen className="h-5 w-5" />}
          title={t("workspace.openFolder")}
          description={t("workspace.openFolderDesc")}
          onClick={onOpenFolder}
        />

        <ChoiceCard
          icon={<Cloud className="h-5 w-5" />}
          title={t("workspace.connectRemote")}
          description={t("workspace.connectRemoteDesc")}
          onClick={onConnectRemote}
        />
      </div>
    </AddWorkspaceContainer>
  )
}
