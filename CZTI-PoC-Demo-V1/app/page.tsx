"use client";
import React, { useState, useEffect, useRef } from "react";

// ============================================================
// 静态配置（碳因子 + 模拟工单 + 状态标签 + 测试网配置）
// ============================================================
const CARBON_FACTORS = {
  HA_APPLIANCE: { name: "废旧家电", baseFactor: 0.068, adjustmentCoeff: 1.0 },
  PLASTIC: { name: "废旧塑料", baseFactor: 0.045, adjustmentCoeff: 0.95 },
  METAL: { name: "废旧金属", baseFactor: 0.012, adjustmentCoeff: 1.05 },
  PAPER: { name: "废纸", baseFactor: 0.038, adjustmentCoeff: 0.9 },
};

const MOCK_WORK_ORDER = {
  demandId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  workOrderId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  anonymousId: "COL-ABG-047",
  category: "HA_APPLIANCE" as keyof typeof CARBON_FACTORS,
  weightGrams: 52000,
  photoHash: "0x9a2b7c4d8eef3f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
  gpsTraceHash: "0x8f3c7d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c",
  signatureHash: "0x7c12b3a4f5d6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
  settlementHash: "0x5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e",
};

// 7 步状态机定义（含完整字段）
const STEP_LABELS = [
  {
    key: "Created",
    title: "已创建",
    role: "用户 / 销售",
    precondition: "无",
    failHandling: "重新提交或取消",
    desc: "提交回收需求，生成 Demand ID",
  },
  {
    key: "Assigned",
    title: "已接单",
    role: "回收员",
    precondition: "已创建",
    failHandling: "退回待接单池，换人接单",
    desc: "分配回收员匿名编号",
  },
  {
    key: "Collected",
    title: "已回收",
    role: "回收员 + 用户",
    precondition: "已接单",
    failHandling: "补拍照片或取消工单",
    desc: "现场交付，上传哈希与签名",
  },
  {
    key: "Sorted",
    title: "已分拣",
    role: "分拣中心",
    precondition: "已回收",
    failHandling: "退回重新称重或判定不合格",
    desc: "称重质检，录入品类与重量",
  },
  {
    key: "Settled",
    title: "已结算",
    role: "平台",
    precondition: "已分拣",
    failHandling: "人工核对后重新结算",
    desc: "核销结算，仅记录结算哈希",
  },
  {
    key: "PoCIssued",
    title: "凭证已生成",
    role: "平台（自动）",
    precondition: "已结算，全环节数据校验通过",
    failHandling: "异常或重复则凭证作废，转人工介入",
    desc: "锁定插槽，生成唯一 PoC 凭证",
  },
  {
    key: "PointsIssued",
    title: "积分已发放",
    role: "平台（自动）",
    precondition: "凭证已生成且有效",
    failHandling: "积分冻结，重新核算后补发",
    desc: "向匿名节点发放绿色积分",
  },
];

// 计算碳减排量
const calculateReduction = (
  category: keyof typeof CARBON_FACTORS,
  weightGrams: number
) => {
  const factor = CARBON_FACTORS[category];
  if (!factor) return 0;
  const weightKg = weightGrams / 1000;
  return Number((weightKg * factor.baseFactor * factor.adjustmentCoeff).toFixed(3));
};

// ============================================================
// V0.5 新增：真实测试网合约配置（请替换为实际部署数据）
// ============================================================
const TESTNET_CONFIG = {
  networkName: "Sepolia Testnet",
  chainId: "11155111",
  explorerBaseUrl: "https://sepolia.etherscan.io",
  pocRegistryAddress: "0x这里替换",
  greenPointsIssuerAddress: "0x这里替换",
  pocRegistryDeployTx: "0x这里替换",
  greenPointsIssuerDeployTx: "0x这里替换",
};

// ============================================================
// 主组件
// ============================================================
export default function PoCDemo() {
  const [activeTab, setActiveTab] = useState<"overview" | "workflow" | "certificate" | "compliance" | "esg">("overview");
  const [currentStep, setCurrentStep] = useState(0);
  const [logs, setLogs] = useState<Array<{ id: string; time: string; text: string }>>([]);
  const [hasMinted, setHasMinted] = useState(false);
  const [dupAttempts, setDupAttempts] = useState(0);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [exportChecked, setExportChecked] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Mock Wallet 角色状态
  const [walletRole, setWalletRole] = useState<string>("Platform Operator");

  const logEndRef = useRef<HTMLDivElement>(null);

  const reduction = calculateReduction(MOCK_WORK_ORDER.category, MOCK_WORK_ORDER.weightGrams);

  const addLog = (text: string) => {
    const timeStr = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { id: Date.now().toString() + Math.random(), time: timeStr, text }]);
  };

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  useEffect(() => {
    addLog("[System] 密码学存证沙盒就绪。");
  }, []);

  // ============================================================
  // 核心业务逻辑
  // ============================================================

  const advanceStep = () => {
    const wo = MOCK_WORK_ORDER;
    const ts = Math.floor(Date.now() / 1000);

    switch (currentStep) {
      case 0:
        addLog(`[Contract] emit DemandCreated(demandId: "${wo.demandId.slice(0, 12)}...", locHash: "0x8f3c...", timestamp: ${ts})`);
        setCurrentStep(1);
        break;
      case 1:
        addLog(`[Contract] emit CollectorAssigned(workOrderId: "${wo.workOrderId.slice(0, 12)}...", anonymousId: "${wo.anonymousId}", timestamp: ${ts})`);
        setCurrentStep(2);
        break;
      case 2:
        addLog(`[Contract] emit CollectionConfirmed(workOrderId: "${wo.workOrderId.slice(0, 12)}...", photoHash: "${wo.photoHash.slice(0, 12)}...", signatureHash: "${wo.signatureHash.slice(0, 12)}...", timestamp: ${ts})`);
        setCurrentStep(3);
        break;
      case 3:
        addLog(`[Contract] emit SortingConfirmed(workOrderId: "${wo.workOrderId.slice(0, 12)}...", weight: ${wo.weightGrams}, category: "${wo.category}", qualityResult: "GRADE_A", timestamp: ${ts})`);
        setCurrentStep(4);
        break;
      case 4:
        addLog(`[Contract] emit SettlementConfirmed(workOrderId: "${wo.workOrderId.slice(0, 12)}...", settlementFlag: true, settlementHash: "${wo.settlementHash.slice(0, 12)}...", timestamp: ${ts})`);
        setCurrentStep(5);
        break;
      case 5:
        addLog(`[Contract] emit PoCIssued(certId: "POC-202606-883", workOrderId: "${wo.workOrderId.slice(0, 12)}...", carbonReduction: "${reduction} kgCO2e", txHash: "0x7c12...", timestamp: ${ts})`);
        setHasMinted(true);
        setCurrentStep(6);
        break;
      case 6:
        addLog(`[Contract] emit PointsIssued(anonymousId: "${wo.anonymousId}", points: ${Math.floor(reduction * 100)}, certId: "POC-202606-883", timestamp: ${ts})`);
        addLog("[System] 生命周期完结合规存证。");
        setCurrentStep(7);
        break;
      default:
        break;
    }
  };

  const handleMintTest = () => {
    if (hasMinted) {
      setDupAttempts((prev) => prev + 1);
      const msg = "Rejected: PoC already issued for this work order. Existing Certificate ID: POC-202606-883";
      addLog(`[VM Exception][REVERT] ${msg}`);
      setErrorBanner(msg + " 工单已锁定，不允许重复发行凭证。");
      return;
    }
    if (currentStep < 5) {
      const msg = "Rejected: Settlement not confirmed.";
      addLog(`[VM Exception][REVERT] ${msg}`);
      setErrorBanner(msg);
      return;
    }
    addLog(`[Contract] Call issuePoC() Success. emit PoCIssued(certId: "POC-202606-883", carbonReduction: "${reduction} kgCO2e")`);
    setHasMinted(true);
    if (currentStep === 5) setCurrentStep(6);
    setErrorBanner(null);
  };

  const resetDemo = () => {
    setCurrentStep(0);
    setLogs([]);
    setHasMinted(false);
    setDupAttempts(0);
    setErrorBanner(null);
    addLog("[System] 沙盒已重置。");
  };

  const handleExport = () => {
    if (!exportChecked) return;
    setExporting(true);
    setTimeout(() => {
      setExporting(false);
      setModalOpen(false);
      setExportChecked(false);
      alert("✅ ESG 聚合报表已导出（不含个人数据）。");
    }, 1000);
  };

  const handleRoleChange = (role: string) => {
    setWalletRole(role);
    addLog(`[Wallet] Role switched to ${role}`);
  };

  // ============================================================
  // Tab 渲染函数
  // ============================================================

  const renderOverview = () => (
    <div className="space-y-6 animate-fade-in">
      <div>
        <span className="text-[10px] font-mono text-[#64FFDA] uppercase tracking-widest">PoC Recovery Proof / Proof of Collection</span>
        <h2 className="text-xl font-bold text-slate-100 tracking-tight mt-1">真实回收行为 → 链上 PoC 凭证 → ESG / 绿色积分 / 碳资产数据底账</h2>
      </div>

      {/* 三张价值卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-[#112240] border border-[#233554] rounded-lg p-5 text-center">
          <div className="text-3xl mb-2">🔗</div>
          <h3 className="text-sm font-bold text-slate-200">真实回收数据上链</h3>
          <p className="text-xs text-slate-400 mt-1">每笔工单全流程哈希存证，不可篡改</p>
        </div>
        <div className="bg-[#112240] border border-[#233554] rounded-lg p-5 text-center">
          <div className="text-3xl mb-2">🔒</div>
          <h3 className="text-sm font-bold text-slate-200">链上只存哈希，不存隐私</h3>
          <p className="text-xs text-slate-400 mt-1">手机号、地址、照片等敏感信息不出境</p>
        </div>
        <div className="bg-[#112240] border border-[#233554] rounded-lg p-5 text-center">
          <div className="text-3xl mb-2">📊</div>
          <h3 className="text-sm font-bold text-slate-200">聚合 ESG 报表可用于审计</h3>
          <p className="text-xs text-slate-400 mt-1">去标识化数据，合规导出，满足监管要求</p>
        </div>
      </div>

      {/* 六大回收环节总览 */}
      <div className="bg-[#112240] border border-[#233554] rounded-lg p-5">
        <h4 className="text-xs font-bold text-slate-400 font-mono tracking-wider mb-4">六大回收环节总览</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554]/50">
            <span className="text-[#64FFDA] font-bold">1.</span>
            <span className="text-slate-300 ml-1">发布回收需求</span>
            <p className="text-slate-500 text-[10px] mt-0.5">用户或销售在 APP 提交回收单</p>
          </div>
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554]/50">
            <span className="text-[#64FFDA] font-bold">2.</span>
            <span className="text-slate-300 ml-1">回收员接单</span>
            <p className="text-slate-500 text-[10px] mt-0.5">回收员看到订单并锁定</p>
          </div>
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554]/50">
            <span className="text-[#64FFDA] font-bold">3.</span>
            <span className="text-slate-300 ml-1">上门回收执行</span>
            <p className="text-slate-500 text-[10px] mt-0.5">回收员到现场拍照，记录轨迹</p>
          </div>
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554]/50">
            <span className="text-[#64FFDA] font-bold">4.</span>
            <span className="text-slate-300 ml-1">分拣中心入库</span>
            <p className="text-slate-500 text-[10px] mt-0.5">送到分拣中心称重、质检</p>
          </div>
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554]/50">
            <span className="text-[#64FFDA] font-bold">5.</span>
            <span className="text-slate-300 ml-1">生成回收凭证</span>
            <p className="text-slate-500 text-[10px] mt-0.5">平台核对全环节数据，自动生成凭证</p>
          </div>
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554]/50">
            <span className="text-[#64FFDA] font-bold">6.</span>
            <span className="text-slate-300 ml-1">碳积分与 ESG 报表</span>
            <p className="text-slate-500 text-[10px] mt-0.5">按重量换算碳减排并发放积分，生成聚合报表</p>
          </div>
        </div>
      </div>

      <div className="bg-[#112240] border border-[#233554] rounded-lg p-5 text-xs text-slate-300 leading-relaxed">
        <p>
          <strong>核心命题：</strong>线下非标回收行为，在满足《个人信息保护法》前提下，
          凝练为不可篡改、防重复、可穿透审计的链上 ESG 碳资产底账。
        </p>
      </div>

      {/* 智能合约接口预览模块 */}
      <div className="bg-[#112240] border border-[#233554] rounded-lg p-5 space-y-4">
        <div>
          <h4 className="text-xs font-bold text-slate-400 font-mono tracking-wider">Smart Contract Interface Preview</h4>
          <p className="text-[10px] text-slate-500 mt-0.5">智能合约接口预览</p>
          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
            当前 DEMO 使用 <span className="text-[#64FFDA] font-mono">Mock Contract Interface</span> 展示 PoC 回收证明机制的链上交互结构。
            后续可替换底层 Hook 接入真实智能合约。
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* 合约 1: PoCRegistry.sol */}
          <div className="bg-[#0A192F] border border-[#233554] rounded-lg p-4">
            <h5 className="font-bold text-[#64FFDA] font-mono text-[11px]">PoCRegistry.sol</h5>
            <p className="text-slate-400 text-[10px] mt-0.5">用途：记录需求、工单、回收、分拣、结算与 PoC 凭证生成事件</p>
            <div className="mt-2 space-y-0.5">
              <span className="text-slate-500 block text-[10px] font-mono">核心方法：</span>
              <div className="flex flex-wrap gap-1 font-mono text-[10px]">
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">createDemandProof()</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">assignCollector()</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">confirmCollection()</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">confirmSorting()</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">confirmSettlement()</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">issuePoC()</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">verifyPoC()</span>
              </div>
            </div>
            <div className="mt-2 space-y-0.5">
              <span className="text-slate-500 block text-[10px] font-mono">核心事件：</span>
              <div className="flex flex-wrap gap-1 font-mono text-[10px] text-amber-400">
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">DemandCreated</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">CollectorAssigned</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">CollectionConfirmed</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">SortingConfirmed</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">SettlementConfirmed</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">PoCIssued</span>
              </div>
            </div>
          </div>
          {/* 合约 2: GreenPointsIssuer.sol */}
          <div className="bg-[#0A192F] border border-[#233554] rounded-lg p-4">
            <h5 className="font-bold text-[#64FFDA] font-mono text-[11px]">GreenPointsIssuer.sol</h5>
            <p className="text-slate-400 text-[10px] mt-0.5">用途：基于有效 PoC 凭证发放绿色积分 / Carbon Points</p>
            <div className="mt-2 space-y-0.5">
              <span className="text-slate-500 block text-[10px] font-mono">核心方法：</span>
              <div className="flex flex-wrap gap-1 font-mono text-[10px]">
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">issuePoints()</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">validatePoCBeforeIssuance()</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50 text-slate-300">freezePointsOnInvalidProof()</span>
              </div>
            </div>
            <div className="mt-2 space-y-0.5">
              <span className="text-slate-500 block text-[10px] font-mono">核心事件：</span>
              <div className="flex flex-wrap gap-1 font-mono text-[10px] text-amber-400">
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">PointsIssued</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">PointsFrozen</span>
                <span className="bg-[#112240] px-1.5 py-0.5 rounded border border-[#233554]/50">PointsRecalculated</span>
              </div>
            </div>
          </div>
        </div>
        <div className="text-[10px] text-slate-500 font-mono border-t border-[#233554]/60 pt-2">
          <span className="text-[#64FFDA]">Mock Contract Interface · ABI Placeholder</span>
          <span className="mx-2">|</span>
          <span className="text-slate-400">Ready for Real Contract Integration</span>
        </div>
      </div>

      {/* V0.5 新增：真实测试网合约证明模块 */}
      <div className="bg-[#112240] border border-[#64FFDA]/30 rounded-lg p-5 space-y-4">
        <div>
          <h4 className="text-xs font-bold text-[#64FFDA] font-mono tracking-wider">Real Testnet Contract Evidence</h4>
          <p className="text-[10px] text-slate-500 mt-0.5">真实测试网合约证明</p>
          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
            当前 DEMO 已预留真实智能合约接入路径。本页展示测试网合约部署证明；为保证商务演示稳定性，当前交互仍使用 Mock Contract Event Log。
            后续可将 Mock Hook 替换为真实合约读取与事件监听。
          </p>
        </div>

        {/* 配置信息展示 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554]">
            <span className="text-slate-500">Network:</span>
            <span className="text-slate-300 ml-2">{TESTNET_CONFIG.networkName}</span>
            <br />
            <span className="text-slate-500">Chain ID:</span>
            <span className="text-slate-300 ml-2">{TESTNET_CONFIG.chainId}</span>
          </div>
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554]">
            <span className="text-slate-500">Integration Mode:</span>
            <span className="text-slate-300 ml-2">Explorer Link + Mock Frontend</span>
            <br />
            <span className="text-slate-500">Status:</span>
            <span className="text-[#64FFDA] ml-2">Contract deployed on testnet, frontend currently uses mock interaction for demo stability</span>
          </div>
        </div>

        {/* 合约地址及交易哈希展示 */}
        <div className="space-y-2 text-xs font-mono">
          <div className="flex flex-wrap items-center gap-2 bg-[#0A192F] p-2 rounded border border-[#233554]/50">
            <span className="text-slate-500 w-40 shrink-0">PoCRegistry Contract:</span>
            <span className="text-slate-300 truncate flex-1">{TESTNET_CONFIG.pocRegistryAddress}</span>
            <button
              onClick={() => window.open(`${TESTNET_CONFIG.explorerBaseUrl}/address/${TESTNET_CONFIG.pocRegistryAddress}`, "_blank")}
              className="text-[#64FFDA] hover:underline text-[10px] shrink-0"
            >
              Open on Explorer
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 bg-[#0A192F] p-2 rounded border border-[#233554]/50">
            <span className="text-slate-500 w-40 shrink-0">GreenPointsIssuer Contract:</span>
            <span className="text-slate-300 truncate flex-1">{TESTNET_CONFIG.greenPointsIssuerAddress}</span>
            <button
              onClick={() => window.open(`${TESTNET_CONFIG.explorerBaseUrl}/address/${TESTNET_CONFIG.greenPointsIssuerAddress}`, "_blank")}
              className="text-[#64FFDA] hover:underline text-[10px] shrink-0"
            >
              Open on Explorer
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 bg-[#0A192F] p-2 rounded border border-[#233554]/50">
            <span className="text-slate-500 w-40 shrink-0">PoCRegistry Deploy Tx:</span>
            <span className="text-slate-300 truncate flex-1">{TESTNET_CONFIG.pocRegistryDeployTx}</span>
            <button
              onClick={() => window.open(`${TESTNET_CONFIG.explorerBaseUrl}/tx/${TESTNET_CONFIG.pocRegistryDeployTx}`, "_blank")}
              className="text-[#64FFDA] hover:underline text-[10px] shrink-0"
            >
              Open Tx
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 bg-[#0A192F] p-2 rounded border border-[#233554]/50">
            <span className="text-slate-500 w-40 shrink-0">GreenPointsIssuer Deploy Tx:</span>
            <span className="text-slate-300 truncate flex-1">{TESTNET_CONFIG.greenPointsIssuerDeployTx}</span>
            <button
              onClick={() => window.open(`${TESTNET_CONFIG.explorerBaseUrl}/tx/${TESTNET_CONFIG.greenPointsIssuerDeployTx}`, "_blank")}
              className="text-[#64FFDA] hover:underline text-[10px] shrink-0"
            >
              Open Tx
            </button>
          </div>
        </div>

        <div className="text-[10px] text-slate-500 font-mono border-t border-[#233554]/60 pt-2">
          <span className="text-amber-400">⚠️</span> 合约地址及交易哈希请替换为实际部署数据。
        </div>
      </div>
    </div>
  );

  const renderWorkflow = () => (
    <div className="space-y-4 animate-fade-in">
      <span className="text-[10px] font-mono text-[#64FFDA] uppercase tracking-widest">7 步状态机</span>

      {/* 状态流转提示 */}
      <div className="bg-[#112240] border border-amber-500/30 rounded-lg p-3 text-xs text-slate-300">
        <p>⚠️ 状态必须按顺序推进，不能跳步；<span className="text-[#FF6B6B]">Settled 之前不能生成 PoC</span>；绿色积分发放必须以有效 PoC 凭证为前提。</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-2">
          {STEP_LABELS.map((step, idx) => {
            const isCompleted = idx < currentStep;
            const isActive = idx === currentStep;
            return (
              <div
                key={step.key}
                className={`p-3 rounded-md border transition-all ${
                  isActive
                    ? "bg-[#172a45] border-[#64FFDA]"
                    : isCompleted
                    ? "bg-[#112240] border-[#64FFDA]/30"
                    : "bg-[#112240]/10 border-transparent opacity-50"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      isCompleted
                        ? "bg-[#64FFDA] text-[#0A192F]"
                        : isActive
                        ? "border-2 border-[#64FFDA] text-[#64FFDA]"
                        : "border border-slate-600 text-slate-600"
                    }`}
                  >
                    {isCompleted ? "✓" : idx + 1}
                  </div>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center justify-between">
                      <span className={`text-sm font-bold ${isActive ? "text-[#64FFDA]" : isCompleted ? "text-slate-200" : "text-slate-500"}`}>
                        {step.title}
                      </span>
                      <span className="text-[10px] text-slate-500">{step.role}</span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">{step.desc}</p>
                    <div className="flex flex-wrap gap-3 text-[10px] text-slate-500 mt-1">
                      <span>前置条件: {step.precondition}</span>
                      <span>| 失败处理: {step.failHandling}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="bg-[#112240] border border-[#233554] rounded-lg p-5 space-y-4 h-fit sticky top-24">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-[#64FFDA] rounded-full animate-pulse" />
            <span className="text-xs font-bold text-slate-300">合约遥控盘</span>
          </div>
          <div className="bg-[#0A192F] p-3 rounded border border-[#233554] font-mono text-[11px]">
            <span className="text-slate-500">就绪接口:</span>
            <span className="text-[#64FFDA] block truncate font-bold mt-1">
              {currentStep === 0 && "createDemandProof()"}
              {currentStep === 1 && "createWorkOrderProof()"}
              {currentStep === 2 && "confirmCollection()"}
              {currentStep === 3 && "confirmSorting()"}
              {currentStep === 4 && "confirmSettlement()"}
              {currentStep === 5 && "issuePoC() [锁]"}
              {currentStep === 6 && "issuePoints()"}
              {currentStep >= 7 && "[闭环]"}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={advanceStep}
              disabled={currentStep >= 7}
              className="flex-1 bg-[#64FFDA] text-[#0A192F] font-bold py-2 rounded text-sm hover:opacity-90 disabled:opacity-20 transition-all cursor-pointer"
            >
              {currentStep >= 7 ? "资产已落锁" : "推进下一步 ➔"}
            </button>
            <button
              onClick={resetDemo}
              className="px-4 border border-[#233554] text-slate-400 py-2 rounded text-sm hover:text-slate-200 transition-all cursor-pointer"
            >
              重置
            </button>
          </div>
          <div className="text-[10px] text-slate-500 text-center">进度: {currentStep}/7</div>
        </div>
      </div>
    </div>
  );

  const renderCertificate = () => (
    <div className="space-y-4 animate-fade-in">
      {errorBanner && (
        <div className="bg-rose-950/40 border border-[#FF6B6B]/40 p-4 rounded-lg animate-shake">
          <p className="text-[#FF6B6B] font-bold text-sm">⛔ {errorBanner}</p>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-[#112240] border border-[#233554] rounded-xl p-6 border-t-4 border-t-[#64FFDA]">
          <div className="flex justify-between items-center border-b border-[#233554] pb-3 mb-4">
            <div>
              <h4 className="font-bold text-slate-200 text-sm font-mono">PoC 链上凭证</h4>
              <p className="text-[10px] text-slate-500 font-mono">Proof of Collection · Cryptographic Evidence</p>
            </div>
            <span
              className={`text-[10px] font-mono px-3 py-1 rounded border ${
                hasMinted
                  ? "bg-emerald-950 text-[#64FFDA] border-emerald-500/20"
                  : "bg-amber-950 text-amber-400 border-amber-500/20"
              }`}
            >
              {hasMinted ? "VALID / LOCKED" : "PENDING"}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-xs font-mono">
            <div>
              <span className="text-slate-500 block text-[10px]">Certificate ID</span>
              <span className="text-slate-300">{hasMinted ? "POC-202606-883" : "[待签发]"}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Work Order ID</span>
              <span className="text-slate-300 truncate block">{MOCK_WORK_ORDER.workOrderId}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Demand ID</span>
              <span className="text-slate-300 truncate block">{MOCK_WORK_ORDER.demandId}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Category</span>
              <span className="text-slate-300">废旧家电 (HA_APPLIANCE)</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Weight</span>
              <span className="text-slate-300">52.00 kg</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Estimated Carbon Reduction</span>
              <span className="text-[#64FFDA] font-bold">{reduction} kgCO₂e</span>
            </div>
            <div className="md:col-span-2">
              <span className="text-slate-500 block text-[10px]">Photo Hash</span>
              <span className="text-slate-400 text-[10px] break-all">{MOCK_WORK_ORDER.photoHash}</span>
            </div>
            <div className="md:col-span-2">
              <span className="text-slate-500 block text-[10px]">GPS Trace Hash</span>
              <span className="text-slate-400 text-[10px] break-all">{MOCK_WORK_ORDER.gpsTraceHash}</span>
            </div>
            <div className="md:col-span-2">
              <span className="text-slate-500 block text-[10px]">Process Hash Chain</span>
              <span className="text-slate-400 text-[10px] break-all">sha256(PhotoHash + TraceHash + SignatureHash)</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Transaction Hash</span>
              <span className="text-slate-300 truncate block">
                {hasMinted ? "0x7c12b3a4f5d6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2" : "[未上链]"}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Issued At</span>
              <span className="text-slate-300">{hasMinted ? "2026-06-29 14:32:08 UTC+8" : "[待签发]"}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px]">Status</span>
              <span className={hasMinted ? "text-[#64FFDA]" : "text-amber-400"}>
                {hasMinted ? "✅ ACTIVE / LOCKED" : "⏳ INITIAL"}
              </span>
            </div>
          </div>

          {/* Mock Block Explorer Preview */}
          <div className="mt-4 p-3 bg-[#0A192F] border border-[#233554] rounded-lg">
            <h5 className="text-[10px] font-bold text-slate-400 font-mono mb-2">Mock Block Explorer Preview</h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono text-slate-400">
              <div><span className="text-slate-500">Block Number:</span> Mock-884201</div>
              <div><span className="text-slate-500">Tx Hash:</span> {hasMinted ? "0x7c12...f1a2" : "[待上链]"}</div>
              <div className="sm:col-span-2">
                <span className="text-slate-500">Event Timeline:</span>
                <span className="text-slate-300 ml-1">
                  DemandCreated → CollectorAssigned → CollectionConfirmed → SortingConfirmed → SettlementConfirmed → PoCIssued
                </span>
              </div>
              <div><span className="text-slate-500">Gas Used:</span> Mock only</div>
              <div><span className="text-slate-500">Notice:</span> 当前为演示链路，不代表真实主网数据</div>
            </div>
          </div>
        </div>

        <div className="bg-[#112240] border border-[#233554] rounded-xl p-5 flex flex-col justify-between">
          <div>
            <h4 className="font-bold text-slate-200 text-sm">防重复发行测试器</h4>
            <p className="text-slate-400 text-xs leading-relaxed mt-2">
              工单一经签发，槽位永久锁定。点击下方按钮模拟重复签发攻击。
            </p>
          </div>
          <div className="space-y-3 mt-4">
            <button
              onClick={handleMintTest}
              disabled={dupAttempts >= 2 || currentStep < 5}
              className={`w-full py-2.5 rounded text-sm font-bold transition-all cursor-pointer ${
                dupAttempts >= 2 || currentStep < 5
                  ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                  : "bg-[#0A192F] border border-[#FF6B6B] text-[#FF6B6B] hover:bg-[#FF6B6B]/10"
              }`}
            >
              {dupAttempts >= 2 ? "🔒 熔断已触发" : "再次签发 PoC 凭证 (攻防测试)"}
            </button>
            {hasMinted && (
              <div className="bg-rose-950/20 border border-rose-900/30 p-2 rounded text-center">
                <p className="text-[#FF6B6B] text-xs font-mono">⛔ 工单已锁定，不允许重复发行凭证。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const renderCompliance = () => (
    <div className="space-y-6 animate-fade-in">
      <h3 className="text-xs font-bold text-slate-400 font-mono tracking-wider">三层合规数据隔离</h3>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 text-xs">
        <div className="bg-[#112240] border border-blue-500/20 rounded-xl p-5">
          <h4 className="font-bold text-blue-400 border-b border-[#233554] pb-2">1. 境内留存层</h4>
          <span className="text-[10px] text-slate-500 block mt-1">🔒 受控访问 · 调阅留痕 · 不对外公开</span>
          <ul className="mt-3 space-y-1 text-slate-300">
            <li>• 手机号</li>
            <li>• 精准地址</li>
            <li>• 原始照片</li>
            <li>• GPS 轨迹明文</li>
            <li>• 回收员真实身份</li>
            <li>• 结算明细</li>
            <li>• 个人级碳减排明细</li>
            <li>• 操作审计日志</li>
          </ul>
        </div>
        <div className="bg-[#112240] border border-[#64FFDA]/20 rounded-xl p-5 shadow-lg shadow-[#64FFDA]/5">
          <h4 className="font-bold text-[#64FFDA] border-b border-[#233554] pb-2">2. 链上存证层</h4>
          <span className="text-[10px] text-slate-500 block mt-1">🌐 密码学脱敏上链 · 不含个人隐私</span>
          <ul className="mt-3 space-y-1 text-slate-300">
            <li>• 需求单号</li>
            <li>• 工单号</li>
            <li>• 凭证号</li>
            <li>• 匿名编号</li>
            <li>• 时间戳</li>
            <li>• 照片哈希</li>
            <li>• 轨迹哈希</li>
            <li>• 电子签名</li>
            <li>• 重量</li>
            <li>• 品类</li>
            <li>• 质检结果</li>
            <li>• 碳减排预估值</li>
          </ul>
          <div className="mt-3 p-2 bg-rose-950/20 border border-rose-900/30 rounded">
            <p className="text-[10px] text-amber-400">
              ❌ 链上不包含手机号、姓名、精准地址、身份证号、人脸、原始照片、GPS 明文、服务费金额或任何可反推个人身份的数据。
            </p>
          </div>
        </div>
        <div className="bg-[#112240] border border-purple-500/20 rounded-xl p-5">
          <h4 className="font-bold text-purple-400 border-b border-[#233554] pb-2">3. 跨境聚合层</h4>
          <span className="text-[10px] text-slate-500 block mt-1">✈️ 仅包含去标识化聚合统计数据</span>
          <ul className="mt-3 space-y-1 text-slate-300">
            <li>• 周期总回收量</li>
            <li>• 品类分布</li>
            <li>• 区域汇总</li>
            <li>• 总碳减排量</li>
            <li>• 方法学版本号</li>
          </ul>
        </div>
      </div>

      {/* R1-R8 合规红线模块 */}
      <div className="bg-[#112240] border border-[#233554] rounded-xl p-5">
        <h4 className="text-xs font-bold text-slate-400 font-mono tracking-wider mb-4">R1–R8 合规操作红线</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px]">
          <div className="bg-[#0A192F] p-2 rounded border border-[#233554]/50"><span className="text-[#FF6B6B] font-bold">R1</span> 个人敏感信息不得明文上链</div>
          <div className="bg-[#0A192F] p-2 rounded border border-[#233554]/50"><span className="text-[#FF6B6B] font-bold">R2</span> 原始照片和 GPS 明文仅存境内</div>
          <div className="bg-[#0A192F] p-2 rounded border border-[#233554]/50"><span className="text-[#FF6B6B] font-bold">R3</span> 真实身份明细未经审查不得出境</div>
          <div className="bg-[#0A192F] p-2 rounded border border-[#233554]/50"><span className="text-[#FF6B6B] font-bold">R4</span> 跨境仅限去标识化聚合统计</div>
          <div className="bg-[#0A192F] p-2 rounded border border-[#233554]/50"><span className="text-[#FF6B6B] font-bold">R5</span> 上链数据必须先脱敏</div>
          <div className="bg-[#0A192F] p-2 rounded border border-[#233554]/50"><span className="text-[#FF6B6B] font-bold">R6</span> 原始数据调阅必须留存审计记录</div>
          <div className="bg-[#0A192F] p-2 rounded border border-[#233554]/50"><span className="text-[#FF6B6B] font-bold">R7</span> 同一工单只能发行一张 PoC 凭证</div>
          <div className="bg-[#0A192F] p-2 rounded border border-[#233554]/50"><span className="text-[#FF6B6B] font-bold">R8</span> 绿色积分发放必须基于有效 PoC 凭证</div>
        </div>
      </div>
    </div>
  );

  const renderEsg = () => (
    <div className="bg-[#112240] border border-[#233554] rounded-xl p-6 space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#233554] pb-4">
        <div>
          <h3 className="text-sm font-bold text-slate-200">ESG 宏观聚合看盘</h3>
          <p className="text-[10px] text-slate-500">仅去标识化聚合数据 · 面向审计与商务展示</p>
        </div>
        <button
          onClick={() => {
            setExportChecked(false);
            setModalOpen(true);
          }}
          className="bg-[#0A192F] border border-[#233554] hover:border-[#64FFDA] text-slate-200 text-xs px-4 py-2 rounded transition-all cursor-pointer"
        >
          📊 导出 ESG 报表
        </button>
      </div>

      {/* 四张核心指标卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-center font-mono">
        <div className="bg-[#0A192F] p-4 rounded-lg border border-[#233554]">
          <div className="text-slate-500 text-[10px]">总回收量</div>
          <div className="text-lg font-bold text-slate-200 mt-1">1,428.52 吨</div>
        </div>
        <div className="bg-[#0A192F] p-4 rounded-lg border border-[#233554]">
          <div className="text-slate-500 text-[10px]">PoC 凭证数量</div>
          <div className="text-lg font-bold text-slate-200 mt-1">12,482 份</div>
        </div>
        <div className="bg-[#0A192F] p-4 rounded-lg border border-[#233554]">
          <div className="text-slate-500 text-[10px]">总碳减排量</div>
          <div className="text-lg font-bold text-[#64FFDA] mt-1">76,842.15 kgCO₂e</div>
        </div>
        <div className="bg-[#0A192F] p-4 rounded-lg border border-[#233554]">
          <div className="text-slate-500 text-[10px]">绿色积分发放</div>
          <div className="text-lg font-bold text-slate-200 mt-1">7,684,215 积分</div>
        </div>
      </div>

      {/* 报表状态 + 碳因子 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        <div className="bg-[#0A192F] p-4 rounded-lg border border-[#233554]">
          <h4 className="font-bold text-slate-300 mb-2">📋 报表状态</h4>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-[#64FFDA] rounded-full animate-pulse" />
            <span className="text-slate-400">聚合数据就绪 · 可导出</span>
          </div>
          <p className="text-slate-500 mt-1">数据版本: PoC-Carbon-Factor-v0.1</p>
        </div>
        <div className="bg-[#0A192F] p-4 rounded-lg border border-[#233554]">
          <h4 className="font-bold text-slate-300 mb-2">📐 碳因子</h4>
          <div className="space-y-1 text-slate-400">
            <div className="flex justify-between"><span>废旧家电</span><span>0.068 × 1.00</span></div>
            <div className="flex justify-between"><span>废旧塑料</span><span>0.045 × 0.95</span></div>
            <div className="flex justify-between"><span>废旧金属</span><span>0.012 × 1.05</span></div>
            <div className="flex justify-between"><span>废纸</span><span>0.038 × 0.90</span></div>
          </div>
          <p className="text-[10px] text-slate-500 mt-2 font-mono">
            Reduction = Weight(kg) × Base × Adj
          </p>
        </div>
      </div>

      {/* DEMO 可演示核心价值 */}
      <div className="bg-[#0A192F] border border-[#233554] rounded-lg p-5">
        <h4 className="text-xs font-bold text-slate-400 font-mono tracking-wider mb-3">DEMO 可演示核心价值</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="bg-[#112240] p-3 rounded border border-[#233554]/50">
            <h5 className="font-bold text-[#64FFDA] mb-1">对管理层与投资方</h5>
            <p className="text-slate-400 leading-relaxed">真实回收量和碳减排数据，是后续 ESG 披露、碳资产申报和机构融资的基础。</p>
          </div>
          <div className="bg-[#112240] p-3 rounded border border-[#233554]/50">
            <h5 className="font-bold text-blue-400 mb-1">对合作方</h5>
            <p className="text-slate-400 leading-relaxed">品牌商、分拣中心、碳汇机构可追溯回收去向，并引用碳减排数据到 ESG 报告。</p>
          </div>
          <div className="bg-[#112240] p-3 rounded border border-[#233554]/50">
            <h5 className="font-bold text-purple-400 mb-1">对合规方</h5>
            <p className="text-slate-400 leading-relaxed">原始数据留境内，链上只有哈希和匿名编号，跨境只允许聚合统计，导出前需人工确认无个人数据。</p>
          </div>
        </div>
      </div>
    </div>
  );

  // ============================================================
  // 主渲染
  // ============================================================
  return (
    <div className="min-h-screen bg-[#0A192F] text-[#E6F1FF] flex flex-col font-sans antialiased pb-56">

      {/* 导航栏 */}
      <header className="bg-[#0A192F] border-b border-[#233554] px-6 py-4 flex flex-wrap items-center justify-between gap-3 shadow-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 bg-[#64FFDA] rounded-sm flex items-center justify-center text-[#0A192F] font-mono font-bold text-xs">P</div>
          <div>
            <span className="text-xs font-mono font-bold tracking-widest text-[#64FFDA]">CZTI PROOF HUB</span>
            <span className="text-[10px] text-slate-500 block">机构级链上回收凭证展示台</span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono flex-wrap">
          {/* 链状态 */}
          <div className="flex items-center gap-1.5 bg-[#112240] border border-[#233554] px-3 py-1 rounded text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-[#64FFDA] animate-pulse" />
            <span>Demo Testnet · Mock Mode</span>
          </div>
          {/* Mock Wallet */}
          <div className="flex items-center gap-2 bg-[#112240] border border-[#233554] px-3 py-1 rounded text-slate-300">
            <span>🔑</span>
            <span className="text-slate-400 text-[10px]">Demo Wallet</span>
            <span className="text-[#64FFDA] text-xs">0xPlatform...ABG</span>
            <div className="w-px h-4 bg-[#233554]" />
            <select
              value={walletRole}
              onChange={(e) => handleRoleChange(e.target.value)}
              className="bg-transparent text-[11px] text-slate-300 border-none outline-none cursor-pointer font-mono"
            >
              <option value="User / Sales Node">User / Sales Node</option>
              <option value="Collector Node">Collector Node</option>
              <option value="Sorting Center Node">Sorting Center Node</option>
              <option value="Platform Operator" selected>Platform Operator</option>
              <option value="Compliance Reviewer">Compliance Reviewer</option>
            </select>
            <span className="text-slate-500 text-[10px] ml-1">|</span>
            <span className="text-slate-400 text-[10px]">Mock Contract Interface</span>
          </div>
        </div>
      </header>

      {/* Tab 切换栏 */}
      <div className="max-w-7xl w-full mx-auto px-6 pt-4 flex flex-wrap gap-1 border-b border-[#233554] pb-2 text-xs font-mono">
        {[
          { key: "overview", label: "Overview" },
          { key: "workflow", label: "7步流转" },
          { key: "certificate", label: "凭证" },
          { key: "compliance", label: "合规分层" },
          { key: "esg", label: "ESG看板" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setActiveTab(tab.key as typeof activeTab);
              setErrorBanner(null);
            }}
            className={`px-4 py-1.5 rounded transition-all cursor-pointer ${
              activeTab === tab.key
                ? "text-[#64FFDA] bg-[#112240] border border-[#233554]"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 主内容 */}
      <div className="max-w-7xl w-full mx-auto p-6 space-y-8 flex-1">
        {activeTab === "overview" && renderOverview()}
        {activeTab === "workflow" && renderWorkflow()}
        {activeTab === "certificate" && renderCertificate()}
        {activeTab === "compliance" && renderCompliance()}
        {activeTab === "esg" && renderEsg()}
      </div>

      {/* 底部合约事件终端 */}
      <div className="bg-[#020c1b] border-t border-[#233554] h-48 fixed bottom-0 left-0 right-0 z-50 p-4 font-mono text-xs flex flex-col shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#112240] pb-1.5 mb-1.5">
          <div className="flex items-center text-[#64FFDA] font-bold gap-1.5">
            <span>[EVM Terminal]</span>
            <span className="font-normal text-slate-400 text-[10px]">智能合约事件监听 (Mock)</span>
          </div>
          <button
            onClick={resetDemo}
            className="text-[10px] text-slate-400 border border-[#233554] px-2 py-0.5 rounded bg-[#112240] hover:text-[#FF6B6B] cursor-pointer transition-colors"
          >
            重置沙盒
          </button>
        </div>
        <div className="flex-1 overflow-y-auto space-y-1 pr-2 text-slate-300">
          {logs.map((log) => (
            <div key={log.id} className="flex items-start gap-2 text-[11px]">
              <span className="text-slate-600 shrink-0">[{log.time}]</span>
              <span
                className={
                  log.text.includes("[VM Exception]")
                    ? "text-[#FF6B6B]"
                    : log.text.includes("[Contract]")
                    ? "text-emerald-400 font-semibold"
                    : log.text.includes("[Wallet]")
                    ? "text-blue-300"
                    : "text-blue-400"
                }
              >
                {log.text}
              </span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* ESG 导出合规弹窗 */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#020c1b]/80 backdrop-blur-sm p-4">
          <div className="bg-[#112240] border border-[#233554] max-w-md w-full rounded-xl shadow-2xl p-6 relative">
            <button
              onClick={() => setModalOpen(false)}
              className="absolute top-3 right-3 text-slate-500 hover:text-slate-300 text-sm cursor-pointer"
            >
              ✕
            </button>
            <h3 className="text-sm font-bold text-slate-200 border-b border-[#233554] pb-3 mb-4">
              🔒 跨境数据合规自查
            </h3>
            <div className="space-y-4 text-xs">
              <div className="bg-[#0A192F] border border-[#233554] p-4 rounded text-slate-300 space-y-2 leading-relaxed">
                <p>
                  本次导出的 ESG 报表仅包含去标识化聚合统计数据，包括周期总回收量、品类分布、区域汇总、总碳减排量和方法学版本号。
                </p>
                <p className="text-[#FF6B6B] bg-rose-950/20 p-2 rounded border border-rose-900/10">
                  ❌ 本报表不包含手机号、姓名、精准地址、身份证号、人脸、原始照片、GPS 明文、单笔工单明细、回收员真实身份或任何可反推个人身份的数据组合。
                </p>
              </div>
              <label className="flex items-start gap-2 cursor-pointer bg-[#0A192F]/50 p-3 rounded hover:bg-[#0A192F] transition-colors">
                <input
                  type="checkbox"
                  checked={exportChecked}
                  onChange={(e) => setExportChecked(e.target.checked)}
                  className="mt-0.5 accent-[#64FFDA] w-4 h-4 cursor-pointer"
                />
                <span className="text-[11px] text-slate-300 select-none">
                  我确认本次导出内容仅为聚合统计数据，不包含个人信息或单笔明细。
                </span>
              </label>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setModalOpen(false)}
                className="flex-1 py-2 rounded border border-[#233554] text-slate-400 text-sm hover:bg-[#0A192F] transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={handleExport}
                disabled={!exportChecked || exporting}
                className={`flex-1 py-2 rounded text-sm font-bold transition-all ${
                  exportChecked && !exporting
                    ? "bg-[#64FFDA] text-[#0A192F] cursor-pointer hover:opacity-90"
                    : "bg-slate-800 text-slate-500 cursor-not-allowed"
                }`}
              >
                {exporting ? "打包中..." : "确认导出"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}