// Handles pausing campaigns by campaign ID
async function pauseCampaign(campaignId) {
    try {
        // Normalizar ID como string para evitar discrepancias ("373" vs 373)
        const key = String(campaignId);

        // Add campaign to paused set
        this.pausedCampaigns = this.pausedCampaigns || new Set();
        
        // Si ya está pausada, no hacer nada
        if (this.pausedCampaigns.has(key)) {
            console.log(`⏸️ Campaign ${key} already paused`);
            return true;
        }
        
        this.pausedCampaigns.add(key);
        console.log(`🛑 PAUSA EFECTIVA: Campaign ${key} paused`);
        
        return true;
    } catch (error) {
        console.error(`Error en pauseCampaign: ${error.message}`);
        throw error;
    }
}

// Check if a campaign is paused
function isCampaignPaused(campaignId) {
    const key = String(campaignId);
    const isPaused = this.pausedCampaigns && this.pausedCampaigns.has(key);
    return isPaused;
}

module.exports = {
    pauseCampaign,
    isCampaignPaused
};