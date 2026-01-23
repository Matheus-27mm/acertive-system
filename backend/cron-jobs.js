/**
 * ACERTIVE - CRON JOBS v2.2
 * Sistema de automação real que roda em segundo plano
 * 
 * Funcionalidades:
 * - Atualização automática de status (pendente → vencido)
 * - Lembretes automáticos por e-mail (7, 3, 1 dia antes e no dia)
 * - Geração automática de cobranças recorrentes
 * - Relatório diário por e-mail (opcional)
 * 
 * COMO USAR:
 * Cole este código no final do seu server.js (antes do app.listen)
 */

// =====================================================
// CONFIGURAÇÕES DOS CRON JOBS
// =====================================================
const CRON_CONFIG = {
  // Atualização de status
  atualizarStatus: {
    ativo: true,
    intervalo: 60 * 60 * 1000, // 1 hora
  },
  
  // Lembretes por e-mail
  lembretes: {
    ativo: true, // Mude para true quando quiser ativar
    intervalo: 60 * 60 * 1000, // 1 hora
    horarioInicio: 8, // Só envia após 8h
    horarioFim: 20, // Só envia até 20h
    diasAntes: [7, 3, 1, 0], // 7 dias, 3 dias, 1 dia, no dia
    diasApos: [1, 3, 7, 15, 30], // Cobranças vencidas
    limitePorExecucao: 50, // Máximo de e-mails por execução
  },
  
  // Cobranças recorrentes
  recorrentes: {
    ativo: true,
    intervalo: 6 * 60 * 60 * 1000, // 6 horas
  },
  
  // Relatório diário
  relatorioDiario: {
    ativo: false, // Mude para true se quiser receber relatório diário
    horario: 8, // 8h da manhã
    emailDestino: null, // Preencha com o e-mail do admin
  }
};

// =====================================================
// JOB 1: ATUALIZAR STATUS DAS COBRANÇAS
// =====================================================
async function jobAtualizarStatus() {
  if (!CRON_CONFIG.atualizarStatus.ativo) return;
  
  try {
    console.log('[CRON] Atualizando status das cobranças...');
    
    // Atualizar cobranças vencidas
    const resultado = await pool.query(`
      UPDATE cobrancas 
      SET status = 'vencido', updated_at = NOW()
      WHERE status = 'pendente' 
        AND vencimento < CURRENT_DATE
      RETURNING id
    `);
    
    if (resultado.rowCount > 0) {
      console.log(`[CRON] ✅ ${resultado.rowCount} cobrança(s) marcada(s) como vencida(s)`);
      
      // Registrar no log
      await pool.query(`
        INSERT INTO logs_acoes (usuario_nome, acao, entidade, detalhes)
        VALUES ('Sistema (Cron)', 'ATUALIZAR_STATUS_AUTOMATICO', 'cobrancas', $1)
      `, [JSON.stringify({ quantidade: resultado.rowCount })]);
    }
    
  } catch (err) {
    console.error('[CRON] Erro ao atualizar status:', err.message);
  }
}

// =====================================================
// JOB 2: ENVIAR LEMBRETES AUTOMÁTICOS
// =====================================================
async function jobEnviarLembretes() {
  if (!CRON_CONFIG.lembretes.ativo) {
    console.log('[CRON] Lembretes desativados');
    return;
  }
  
  if (!emailTransporter) {
    console.log('[CRON] E-mail não configurado, pulando lembretes');
    return;
  }
  
  // Verificar horário comercial
  const horaAtual = new Date().getHours();
  if (horaAtual < CRON_CONFIG.lembretes.horarioInicio || horaAtual >= CRON_CONFIG.lembretes.horarioFim) {
    console.log('[CRON] Fora do horário de envio de lembretes');
    return;
  }
  
  try {
    console.log('[CRON] Processando lembretes automáticos...');
    let enviados = 0;
    const limite = CRON_CONFIG.lembretes.limitePorExecucao;
    
    // Buscar configurações do escritório para o nome
    const configResult = await pool.query('SELECT nome_escritorio FROM configuracoes_escritorio LIMIT 1');
    const nomeEmpresa = configResult.rows[0]?.nome_escritorio || 'ACERTIVE';
    
    // 1. LEMBRETES ANTES DO VENCIMENTO
    for (const dias of CRON_CONFIG.lembretes.diasAntes) {
      if (enviados >= limite) break;
      
      const tipoLembrete = dias === 0 ? 'vencimento_hoje' : `vencimento_${dias}d`;
      
      // Buscar cobranças que vencem em X dias e ainda não receberam este lembrete
      const cobrancas = await pool.query(`
        SELECT c.id, c.descricao, c.valor_atualizado, c.vencimento,
               cl.id as cliente_id, cl.nome as cliente_nome, cl.email as cliente_email
        FROM cobrancas c
        INNER JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.status = 'pendente'
          AND DATE(c.vencimento) = CURRENT_DATE + INTERVAL '${dias} days'
          AND cl.email IS NOT NULL 
          AND cl.email != ''
          AND c.id NOT IN (
            SELECT CAST(detalhes->>'cobranca_id' AS UUID)
            FROM logs_acoes 
            WHERE acao = 'LEMBRETE_AUTOMATICO'
              AND detalhes->>'tipo' = $1
              AND DATE(created_at) = CURRENT_DATE
          )
        LIMIT $2
      `, [tipoLembrete, limite - enviados]);
      
      for (const cob of cobrancas.rows) {
        try {
          await enviarEmailLembreteAutomatico(cob, tipoLembrete, nomeEmpresa, dias);
          enviados++;
          
          // Registrar envio
          await pool.query(`
            INSERT INTO logs_acoes (usuario_nome, acao, entidade, entidade_id, detalhes)
            VALUES ('Sistema (Cron)', 'LEMBRETE_AUTOMATICO', 'cobrancas', $1, $2)
          `, [cob.id, JSON.stringify({ tipo: tipoLembrete, email: cob.cliente_email, dias_para_vencer: dias })]);
          
        } catch (emailErr) {
          console.error(`[CRON] Erro ao enviar lembrete para ${cob.cliente_email}:`, emailErr.message);
        }
      }
    }
    
    // 2. LEMBRETES DE COBRANÇAS VENCIDAS
    for (const dias of CRON_CONFIG.lembretes.diasApos) {
      if (enviados >= limite) break;
      
      const tipoLembrete = `atraso_${dias}d`;
      
      const cobrancas = await pool.query(`
        SELECT c.id, c.descricao, c.valor_atualizado, c.vencimento,
               cl.id as cliente_id, cl.nome as cliente_nome, cl.email as cliente_email,
               CURRENT_DATE - DATE(c.vencimento) as dias_atraso
        FROM cobrancas c
        INNER JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.status IN ('pendente', 'vencido')
          AND DATE(c.vencimento) = CURRENT_DATE - INTERVAL '${dias} days'
          AND cl.email IS NOT NULL 
          AND cl.email != ''
          AND c.id NOT IN (
            SELECT CAST(detalhes->>'cobranca_id' AS UUID)
            FROM logs_acoes 
            WHERE acao = 'LEMBRETE_AUTOMATICO'
              AND detalhes->>'tipo' = $1
          )
        LIMIT $2
      `, [tipoLembrete, limite - enviados]);
      
      for (const cob of cobrancas.rows) {
        try {
          await enviarEmailLembreteAutomatico(cob, tipoLembrete, nomeEmpresa, -dias);
          enviados++;
          
          await pool.query(`
            INSERT INTO logs_acoes (usuario_nome, acao, entidade, entidade_id, detalhes)
            VALUES ('Sistema (Cron)', 'LEMBRETE_AUTOMATICO', 'cobrancas', $1, $2)
          `, [cob.id, JSON.stringify({ tipo: tipoLembrete, email: cob.cliente_email, dias_atraso: dias })]);
          
        } catch (emailErr) {
          console.error(`[CRON] Erro ao enviar cobrança para ${cob.cliente_email}:`, emailErr.message);
        }
      }
    }
    
    if (enviados > 0) {
      console.log(`[CRON] ✅ ${enviados} lembrete(s) enviado(s)`);
    } else {
      console.log('[CRON] Nenhum lembrete a enviar');
    }
    
  } catch (err) {
    console.error('[CRON] Erro ao processar lembretes:', err.message);
  }
}

// =====================================================
// FUNÇÃO: ENVIAR E-MAIL DE LEMBRETE AUTOMÁTICO
// =====================================================
async function enviarEmailLembreteAutomatico(cobranca, tipo, nomeEmpresa, diasParaVencer) {
  const isAtraso = diasParaVencer < 0;
  const diasAtraso = Math.abs(diasParaVencer);
  
  // Definir assunto e cor baseado no tipo
  let assunto, corPrincipal, icone, mensagemPrincipal;
  
  if (tipo === 'vencimento_hoje') {
    assunto = `⚠️ VENCE HOJE: Cobrança ${fmtMoney(cobranca.valor_atualizado)}`;
    corPrincipal = '#ef4444';
    icone = '🚨';
    mensagemPrincipal = 'Sua cobrança vence <strong>HOJE</strong>!';
  } else if (tipo.startsWith('vencimento_')) {
    assunto = `📅 Lembrete: Cobrança vence em ${diasParaVencer} dia(s)`;
    corPrincipal = diasParaVencer <= 3 ? '#f59e0b' : '#3b82f6';
    icone = '📅';
    mensagemPrincipal = `Sua cobrança vence em <strong>${diasParaVencer} dia(s)</strong>.`;
  } else {
    assunto = `❌ ATRASO: Cobrança vencida há ${diasAtraso} dia(s)`;
    corPrincipal = '#dc2626';
    icone = '❌';
    mensagemPrincipal = `Sua cobrança está em <strong>ATRASO há ${diasAtraso} dia(s)</strong>.`;
  }
  
  const htmlEmail = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f4f4f4;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    
    <div style="background:linear-gradient(135deg,#1a1a1a,#2d2d2d);padding:30px;text-align:center;border-bottom:4px solid #F6C84C;">
      <div style="width:60px;height:60px;background:#F6C84C;border-radius:12px;display:inline-block;line-height:60px;font-size:28px;font-weight:900;color:#1a1a1a;">A</div>
      <h1 style="color:#fff;font-size:24px;margin:15px 0 5px;">${nomeEmpresa}</h1>
      <p style="color:#F6C84C;font-size:12px;margin:0;">SISTEMA DE COBRANÇAS</p>
    </div>
    
    <div style="padding:30px;">
      <div style="background:${corPrincipal};color:#fff;padding:15px 20px;border-radius:10px;text-align:center;margin-bottom:25px;">
        <span style="font-size:24px;">${icone}</span>
        <p style="margin:10px 0 0;font-size:16px;">${mensagemPrincipal}</p>
      </div>
      
      <p style="font-size:16px;color:#333;margin-bottom:20px;">Olá <strong>${cobranca.cliente_nome}</strong>,</p>
      
      <div style="background:#f8f9fa;border-radius:12px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:8px 0;color:#666;font-size:14px;">Descrição:</td>
            <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600;text-align:right;">${cobranca.descricao || 'Cobrança'}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666;font-size:14px;">Vencimento:</td>
            <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600;text-align:right;">${fmtDate(cobranca.vencimento)}</td>
          </tr>
          <tr style="border-top:2px solid #e9ecef;">
            <td style="padding:15px 0 8px;color:#333;font-size:16px;font-weight:700;">VALOR:</td>
            <td style="padding:15px 0 8px;color:${corPrincipal};font-size:24px;font-weight:900;text-align:right;">${fmtMoney(cobranca.valor_atualizado)}</td>
          </tr>
        </table>
      </div>
      
      ${isAtraso ? `
      <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:15px;border-radius:8px;margin-bottom:20px;">
        <p style="color:#991b1b;margin:0;font-size:14px;">
          <strong>⚠️ Atenção:</strong> Cobranças em atraso podem gerar juros e multas. 
          Entre em contato para regularizar sua situação.
        </p>
      </div>
      ` : `
      <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:15px;border-radius:8px;margin-bottom:20px;">
        <p style="color:#166534;margin:0;font-size:14px;">
          <strong>💡 Dica:</strong> Pague em dia e evite juros e multas!
        </p>
      </div>
      `}
      
      <p style="font-size:14px;color:#666;margin-bottom:0;">
        Em caso de dúvidas ou se já efetuou o pagamento, entre em contato conosco.
      </p>
    </div>
    
    <div style="background:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #e9ecef;">
      <p style="color:#999;font-size:11px;margin:0;">
        Este é um e-mail automático do sistema ${nomeEmpresa}.<br>
        Por favor, não responda diretamente a este e-mail.
      </p>
    </div>
    
  </div>
</body>
</html>
  `;
  
  const emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER;
  
  await emailTransporter.sendMail({
    from: `"${nomeEmpresa}" <${emailFrom}>`,
    to: cobranca.cliente_email,
    subject: assunto,
    html: htmlEmail
  });
}

// =====================================================
// JOB 3: GERAR COBRANÇAS RECORRENTES
// =====================================================
async function jobGerarRecorrentes() {
  if (!CRON_CONFIG.recorrentes.ativo) return;
  
  try {
    console.log('[CRON] Verificando cobranças recorrentes...');
    
    // Buscar recorrentes ativas que precisam gerar cobrança
    const recorrentes = await pool.query(`
      SELECT cr.*, cl.nome as cliente_nome
      FROM cobrancas_recorrentes cr
      INNER JOIN clientes cl ON cl.id = cr.cliente_id
      WHERE cr.ativo = true
        AND (cr.data_fim IS NULL OR cr.data_fim >= CURRENT_DATE)
        AND (
          cr.ultima_geracao IS NULL 
          OR (
            cr.frequencia = 'mensal' AND cr.ultima_geracao < CURRENT_DATE - INTERVAL '25 days'
          )
          OR (
            cr.frequencia = 'quinzenal' AND cr.ultima_geracao < CURRENT_DATE - INTERVAL '12 days'
          )
          OR (
            cr.frequencia = 'semanal' AND cr.ultima_geracao < CURRENT_DATE - INTERVAL '5 days'
          )
        )
    `);
    
    let geradas = 0;
    
    for (const rec of recorrentes.rows) {
      try {
        // Calcular próximo vencimento
        const hoje = new Date();
        let vencimento = new Date(hoje.getFullYear(), hoje.getMonth(), rec.dia_vencimento);
        
        // Se o dia já passou este mês, usar próximo mês
        if (vencimento <= hoje) {
          vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 1, rec.dia_vencimento);
        }
        
        const vencimentoStr = vencimento.toISOString().split('T')[0];
        const mesRef = vencimento.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        
        // Verificar se já existe cobrança para este período
        const existe = await pool.query(`
          SELECT id FROM cobrancas 
          WHERE cliente_id = $1 
            AND descricao LIKE $2
            AND DATE(vencimento) = $3
        `, [rec.cliente_id, `%${mesRef}%`, vencimentoStr]);
        
        if (existe.rowCount > 0) continue;
        
        // Criar nova cobrança
        const novaCobranca = await pool.query(`
          INSERT INTO cobrancas (cliente_id, empresa_id, descricao, valor_original, valor_atualizado, vencimento, status)
          VALUES ($1, $2, $3, $4, $4, $5, 'pendente')
          RETURNING id
        `, [
          rec.cliente_id,
          rec.empresa_id || null,
          `${rec.descricao || 'Cobrança recorrente'} - ${mesRef}`,
          rec.valor,
          vencimentoStr
        ]);
        
        // Atualizar recorrente
        await pool.query(`
          UPDATE cobrancas_recorrentes 
          SET ultima_geracao = CURRENT_DATE, total_geradas = total_geradas + 1, updated_at = NOW()
          WHERE id = $1
        `, [rec.id]);
        
        geradas++;
        
        // Registrar no log
        await pool.query(`
          INSERT INTO logs_acoes (usuario_nome, acao, entidade, entidade_id, detalhes)
          VALUES ('Sistema (Cron)', 'GERAR_RECORRENTE_AUTOMATICO', 'cobrancas', $1, $2)
        `, [novaCobranca.rows[0].id, JSON.stringify({ recorrente_id: rec.id, cliente: rec.cliente_nome })]);
        
      } catch (recErr) {
        console.error(`[CRON] Erro ao gerar recorrente ${rec.id}:`, recErr.message);
      }
    }
    
    if (geradas > 0) {
      console.log(`[CRON] ✅ ${geradas} cobrança(s) recorrente(s) gerada(s)`);
    }
    
  } catch (err) {
    console.error('[CRON] Erro ao processar recorrentes:', err.message);
  }
}

// =====================================================
// JOB 4: RELATÓRIO DIÁRIO (OPCIONAL)
// =====================================================
async function jobRelatorioDiario() {
  if (!CRON_CONFIG.relatorioDiario.ativo || !CRON_CONFIG.relatorioDiario.emailDestino) return;
  
  const horaAtual = new Date().getHours();
  if (horaAtual !== CRON_CONFIG.relatorioDiario.horario) return;
  
  try {
    console.log('[CRON] Gerando relatório diário...');
    
    // Buscar estatísticas
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pago') as pagas,
        COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
        COUNT(*) FILTER (WHERE status = 'vencido') as vencidas,
        COALESCE(SUM(valor_atualizado) FILTER (WHERE status = 'pago'), 0) as total_recebido,
        COALESCE(SUM(valor_atualizado) FILTER (WHERE status IN ('pendente', 'vencido')), 0) as total_a_receber
      FROM cobrancas
    `);
    
    const vencendoHoje = await pool.query(`
      SELECT COUNT(*) as total, COALESCE(SUM(valor_atualizado), 0) as valor
      FROM cobrancas WHERE status = 'pendente' AND DATE(vencimento) = CURRENT_DATE
    `);
    
    const s = stats.rows[0];
    const vh = vencendoHoje.rows[0];
    
    const configResult = await pool.query('SELECT nome_escritorio FROM configuracoes_escritorio LIMIT 1');
    const nomeEmpresa = configResult.rows[0]?.nome_escritorio || 'ACERTIVE';
    
    const htmlRelatorio = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f4f4f4;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">
    <div style="background:#1a1a1a;padding:25px;text-align:center;border-bottom:4px solid #F6C84C;">
      <h1 style="color:#fff;font-size:22px;margin:0;">📊 Relatório Diário - ${nomeEmpresa}</h1>
      <p style="color:#F6C84C;font-size:12px;margin:10px 0 0;">${new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>
    
    <div style="padding:25px;">
      <h3 style="color:#333;margin-bottom:15px;">📈 Resumo Geral</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:25px;">
        <tr style="background:#f8f9fa;">
          <td style="padding:12px;border:1px solid #e9ecef;">Total Recebido</td>
          <td style="padding:12px;border:1px solid #e9ecef;text-align:right;font-weight:700;color:#22c55e;">${fmtMoney(s.total_recebido)}</td>
        </tr>
        <tr>
          <td style="padding:12px;border:1px solid #e9ecef;">Total a Receber</td>
          <td style="padding:12px;border:1px solid #e9ecef;text-align:right;font-weight:700;color:#f59e0b;">${fmtMoney(s.total_a_receber)}</td>
        </tr>
        <tr style="background:#f8f9fa;">
          <td style="padding:12px;border:1px solid #e9ecef;">Cobranças Pagas</td>
          <td style="padding:12px;border:1px solid #e9ecef;text-align:right;font-weight:700;">${s.pagas}</td>
        </tr>
        <tr>
          <td style="padding:12px;border:1px solid #e9ecef;">Cobranças Pendentes</td>
          <td style="padding:12px;border:1px solid #e9ecef;text-align:right;font-weight:700;">${s.pendentes}</td>
        </tr>
        <tr style="background:#f8f9fa;">
          <td style="padding:12px;border:1px solid #e9ecef;">Cobranças Vencidas</td>
          <td style="padding:12px;border:1px solid #e9ecef;text-align:right;font-weight:700;color:#ef4444;">${s.vencidas}</td>
        </tr>
      </table>
      
      <div style="background:#fef3c7;border-left:4px solid #F6C84C;padding:15px;border-radius:8px;">
        <h4 style="color:#854d0e;margin:0 0 10px;">⚠️ Vencendo Hoje</h4>
        <p style="color:#854d0e;margin:0;font-size:14px;">
          <strong>${vh.total}</strong> cobrança(s) no valor total de <strong>${fmtMoney(vh.valor)}</strong>
        </p>
      </div>
    </div>
    
    <div style="background:#f8f9fa;padding:15px;text-align:center;">
      <p style="color:#999;font-size:11px;margin:0;">Relatório gerado automaticamente pelo sistema ${nomeEmpresa}</p>
    </div>
  </div>
</body>
</html>
    `;
    
    const emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER;
    
    await emailTransporter.sendMail({
      from: `"${nomeEmpresa}" <${emailFrom}>`,
      to: CRON_CONFIG.relatorioDiario.emailDestino,
      subject: `📊 Relatório Diário - ${new Date().toLocaleDateString('pt-BR')}`,
      html: htmlRelatorio
    });
    
    console.log('[CRON] ✅ Relatório diário enviado');
    
  } catch (err) {
    console.error('[CRON] Erro ao enviar relatório diário:', err.message);
  }
}

// =====================================================
// INICIAR CRON JOBS
// =====================================================
function iniciarCronJobs() {
  console.log('[CRON] ========================================');
  console.log('[CRON] Iniciando sistema de automação...');
  console.log('[CRON] ========================================');
  
  // Job 1: Atualizar status (a cada 1 hora)
  setInterval(jobAtualizarStatus, CRON_CONFIG.atualizarStatus.intervalo);
  console.log('[CRON] ✅ Job "Atualizar Status" agendado (1h)');
  
  // Job 2: Lembretes (a cada 1 hora)
  setInterval(jobEnviarLembretes, CRON_CONFIG.lembretes.intervalo);
  console.log(`[CRON] ${CRON_CONFIG.lembretes.ativo ? '✅' : '⏸️'} Job "Lembretes" ${CRON_CONFIG.lembretes.ativo ? 'agendado (1h)' : 'DESATIVADO'}`);
  
  // Job 3: Recorrentes (a cada 6 horas)
  setInterval(jobGerarRecorrentes, CRON_CONFIG.recorrentes.intervalo);
  console.log('[CRON] ✅ Job "Recorrentes" agendado (6h)');
  
  // Job 4: Relatório diário (a cada 1 hora, mas só executa no horário definido)
  setInterval(jobRelatorioDiario, 60 * 60 * 1000);
  console.log(`[CRON] ${CRON_CONFIG.relatorioDiario.ativo ? '✅' : '⏸️'} Job "Relatório Diário" ${CRON_CONFIG.relatorioDiario.ativo ? 'agendado' : 'DESATIVADO'}`);
  
  // Executar jobs iniciais após 30 segundos
  setTimeout(async () => {
    console.log('[CRON] Executando verificação inicial...');
    await jobAtualizarStatus();
    await jobGerarRecorrentes();
  }, 30000);
  
  console.log('[CRON] ========================================');
}

// Iniciar quando o servidor subir
iniciarCronJobs();

// =====================================================
// ROTAS DE API PARA GERENCIAR CRON JOBS
// =====================================================

// GET /api/cron/status - Ver status dos jobs
app.get('/api/cron/status', auth, (req, res) => {
  res.json({
    success: true,
    config: CRON_CONFIG,
    emailConfigurado: !!emailTransporter
  });
});

// POST /api/cron/config - Atualizar configurações
app.post('/api/cron/config', authAdmin, (req, res) => {
  try {
    const { job, config } = req.body;
    
    if (job && CRON_CONFIG[job]) {
      Object.assign(CRON_CONFIG[job], config);
      res.json({ success: true, message: `Configuração de ${job} atualizada`, config: CRON_CONFIG[job] });
    } else {
      res.status(400).json({ success: false, message: 'Job inválido' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cron/executar/:job - Executar job manualmente
app.post('/api/cron/executar/:job', authAdmin, async (req, res) => {
  try {
    const { job } = req.params;
    
    switch (job) {
      case 'atualizar-status':
        await jobAtualizarStatus();
        break;
      case 'lembretes':
        await jobEnviarLembretes();
        break;
      case 'recorrentes':
        await jobGerarRecorrentes();
        break;
      case 'relatorio':
        await jobRelatorioDiario();
        break;
      default:
        return res.status(400).json({ success: false, message: 'Job inválido' });
    }
    
    res.json({ success: true, message: `Job ${job} executado com sucesso` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

console.log('[CRON] ✅ Sistema de Cron Jobs carregado');
