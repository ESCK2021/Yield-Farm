// ---------------------------------------- Specification ----------------------------------------------
const ethers = require('ethers');
const WebSocket = require('ws');
require('dotenv').config()
const fetch = require("node-fetch"); //@v2 

const provider = new ethers.providers.WebSocketProvider(process.env.WWS); // Use WebSocket to listen events
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
const signer = wallet.connect(provider);
// For computation of optimal frequency
const WolframAlphaAPI = require('wolfram-alpha-api');
const waApi = WolframAlphaAPI('4U65GE-5E2AHT448U');
// Common variables:
const pid_CAKE_BNB_LP = 251;
const farmMultiplier_CAKE_BNB = 40; 
const totalFarmMultiplier = 102.1;
const totalEmissionPerDay = 72400;
const deadline = Date.now() + 1000 * 60 * 10; // 10 minutes
const ETHERSCAN_TX_URL = "https://bscscan.com/tx/";
const api_CAKE = 'https://api.pancakeswap.info/api/v2/tokens/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'; // API_URL of CAKE token
const api_WBNB = 'https://api.pancakeswap.info/api/v2/tokens/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'; // API_URL of WBNB token

const addresses = {
    Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E', // PancakeSwap RouterV2 contract
    Staking: '0x73feaa1eE314F8c655E354234017bE2193C9E24E', // PancakeSwap MasterChef contract
    Pair_CAKE_BNB: '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0', // CAKE-WBNB Pair contract
    CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // CAKE contract
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB contract
}
// ----------------------------------------- Contracts ----------------------------------------------
const router = new ethers.Contract(
    addresses.Router,
    [
        'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
        'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
        'function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB, uint liquidity)'
    ],
    signer
);
const staking = new ethers.Contract(
    addresses.Staking,
    [
        'function deposit(uint256 _pid, uint256 _amount) public',
        'function pendingCake(uint256 _pid, address _user) external view returns (uint256)',
    ],
    signer
);
const pair_CAKE_BNB = new ethers.Contract(
    addresses.Pair_CAKE_BNB,
    [
        'function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)',
        'function balanceOf(address owner) external view returns (uint)',
        'function totalSupply() external view returns (uint)',
        'function approve(address spender, uint value) external returns (bool)',
    ],
    signer
);
const CAKE = new ethers.Contract(
    addresses.CAKE,
    [
      'function approve(address spender, uint amount) public returns(bool)',
    ],
    signer
);
const WBNB = new ethers.Contract(
    addresses.WBNB,
    [
      'function approve(address spender, uint amount) public returns(bool)',
    ],
    signer
  );
// ------------------------------------------ Get Data -----------------------------------------------
// Step: Check owner principal and pending reward
// Step: Check tokens price, used API
// Step: Check pair total supply and liquidity for LP price
async function get_Pool_User_Info(_pid, sender_address, api_token_from, api_token_to) {
    try {
        console.log("Acquire Data...");
        // LP amount, not staking amount(Future Improvement)
        const LP_amount_BigNumber = await pair_CAKE_BNB.balanceOf(sender_address);
        const LP_amount = parseFloat(ethers.utils.formatEther(LP_amount_BigNumber));
        // pending reward
        const pendingReward_BigNumber = await staking.pendingCake(_pid, sender_address);
        const pendingReward = parseFloat(ethers.utils.formatEther(pendingReward_BigNumber));
        // Calculate from_token(reward) price
        const response_from = await fetch(api_token_from);
        const data_from = await response_from.json();
        const from_token_price = parseFloat(data_from.data.price);
        // Calculate to_token price
        const response_to = await fetch(api_token_to);
        const data_to = await response_to.json();
        const to_token_price = parseFloat(data_to.data.price);
        // Calculate LP value in usd
        const reserves = await pair_CAKE_BNB.getReserves();
        const liquidity = ((reserves[0] * from_token_price) + (reserves[1] * to_token_price)) / (10 ** 18);
        const totalSupply_BigNumber = await pair_CAKE_BNB.totalSupply();
        const totalSupply = parseFloat(ethers.utils.formatEther(totalSupply_BigNumber));
        const LP_price = liquidity / totalSupply; // Per LP token
        const LP_amount_in_usd = LP_amount * LP_price; 
        return [liquidity, from_token_price, LP_amount_in_usd, pendingReward];
    } catch (e) {
        console.log("Cannot get data!");
        console.log(e);
    }
}
// ---------------------------------------- Calculations ---------------------------------------------
// Step: Calculate daily return
function calculateAPR(liquidity, reward_token_price, farmMultiplier) {
    //No. of Token received in target pair farm per day  
    const token_num = totalEmissionPerDay / totalFarmMultiplier * farmMultiplier;
    //daily farm return = no of CAKE * price of CAKE / inital deposit
    const APR = ((token_num * reward_token_price) / liquidity) * 365;
    return APR;
}
// Step: Optimal frequency computation with external API
async function optimal_frequency_computation(principal, APR, gasFee) {
    try {
        console.log("Initiate computation, please wait...\n")
        //const input = `maximize y=(${principal}-x*(${gasFee}\/${APR}))*(1+(${APR}\/x))^x +x*(${gasFee}\/${APR})`; // Precise formula, huge computation
        const input = `maximize y=${principal}*(1+((${APR}\/x)-(${gasFee}\/${principal})))^x on [1, 365]`;  // Appromximate formula
        const queryresult = await waApi.getFull({ input: input, format: 'plaintext' });
        const global_maxima = queryresult.pods[1].subpods[0].plaintext;
        const local_maxima = queryresult.pods[2].subpods[0].plaintext;
        if (global_maxima == "(no global maxima found)") {
            const frequency_string = local_maxima.split("≈").slice(-1);
            const optimal_frequency = parseFloat(frequency_string);
            return optimal_frequency;
        } else {
            const frequency_string = global_maxima.split("≈").slice(-1);
            const optimal_frequency = parseFloat(frequency_string);
            return optimal_frequency;
        }
    } catch (e) {
        console.log("Cannot compute optimal frequency!");
        console.log(e);
    }
}
// Step: Calculate effective rate and find the optimal compounding frequency
// Step: Show difference in value of optimal-compounded and non-compounded
async function checkCompoundFrequency(APR, LP_amount_in_usd, pendingReward, reward_token_price) {
    if (LP_amount_in_usd != 0) {
        try {
            // As "provider.getGasPrice()" funcion only provide estimation of normal transaction, gas fee of interacting with Smart Contract with be much higher
            // Assumption on GasFree(USD): Approve:0.1 * 3, Deposit/Harvest:0.25 * 2, Swap:0.6, Add Liquidity:0.6. Hence, total gas fee = 2 usd. (Based on average on BscScan)
            // Note: Atomic swap and depsoit is possible in Uniswap V3, hence can lower the gas fee
            const gasFee = 2;

            const optimal_frequency = await optimal_frequency_computation(LP_amount_in_usd, APR, gasFee);
            const optimal_frequency_hourly = 365 / optimal_frequency * 24;
            const optimal_compounded_APY = ((1 + ((APR / optimal_frequency) - (gasFee / LP_amount_in_usd))) ** optimal_frequency) - 1;
        
            const thresholdReward_in_usd = LP_amount_in_usd * optimal_compounded_APY / optimal_frequency;
            const pendingReward_in_usd = pendingReward * reward_token_price;
            const estimate_time_pending = ((thresholdReward_in_usd - pendingReward_in_usd) / thresholdReward_in_usd) * optimal_frequency_hourly;

            console.log(`Optimal Frequency: Every ${(optimal_frequency_hourly).toFixed(0)} hours`);
            console.log(`Optimal compounding APY: ${(optimal_compounded_APY * 100).toFixed(3)} %`);
            console.log(`Non-compounding APY: ${(APR * 100).toFixed(3)} %`);
            console.log(`Return Difference: ${((optimal_compounded_APY - APR) * 100).toFixed(3)} %`);

            if (pendingReward_in_usd > thresholdReward_in_usd) {
                execution = true;
                console.log("\nStart compounding");
            } else {
                execution = false;
                console.log("\nNot the right time!");
            };
            return [execution, optimal_frequency_hourly, estimate_time_pending];
        } catch (e) {
            console.log("Cannot get execution!");
            console.log(e);
        }
    }
}
// ---------------------------------------- Executions ---------------------------------------------
// Step: To convert 50% CAKE to WBNB
// Note: Swap fee 0.25% is not included in gas fee calculation
async function swapReward(address_token_from, address_token_to, rewardAmount) {
    try {
        // create transaction parameters
        const path = [address_token_from, address_token_to];
        const to = signer;
        const from_amount = ethers.utils.parseUnits(rewardAmount.toString(), 'ether');
        const amounts = await router.getAmountsOut(from_amount, path); //
        const amountOutMin = amounts[1].sub(amounts[1].div(10)); // Set minimum rate at 90%
        // Approve for both token 
        await CAKE.approve(addresses.Router, rewardAmount);
        await WBNB.approve(addresses.Router, rewardAmount); 
        // Swap
        const to_swapAmountOut = await router.swapExactTokensForTokens(
            from_amount,
            amountOutMin,
            path,
            to,
            deadline,
            // Note: Gas option can be made : { gasLimit: ethers.utils.hexlify(200000), gasPrice: ethers.utils.parseUnits("10", "gwei") }
        );
        console.log("Swapped token");
        return [from_amount, to_swapAmountOut];
    } catch (e) {
        console.log("Cannot swap reward token!");
        console.log(e);
    }
}
// Step: To convert from_token and to_token into LP token
async function convertToLP(addrress_token_from, address_token_to, from_amount, to_swapAmountOut) {
    try {
        const RewardLP_amount = router.addLiquidity(addrress_token_from, address_token_to, from_amount, to_swapAmountOut, from_amount * 0.95, to_swapAmountOut * 0.95, signer, deadline); //signer?
        console.log("Converted LP")
        return RewardLP_amount;
    } catch (e) {
        console.log("Cannot get reward LP");
        console.log(e);
    }
}
// Step: To deposit new LP back to the pool OR claim Farm reward when RewardLP_amount == 0
// Note: Harvest only claims Base Farm rewards(CAKE), LP reward is not included
async function depositRewardLP(_pid, RewardLP_amount) {
    try {
        await pair_CAKE_BNB.approve(addresses.Router, RewardLP_amount * 2);
        const added_deposit = await staking.deposit(_pid, RewardLP_amount);
        if (RewardLP_amount = 0) {
            console.log("Harvest successfully!");
            return added_deposit; // Harvest amount
        } else {
            added_deposit.wait()
            console.log("Execution succeed!")
            console.log(`View tx: ${ETHERSCAN_TX_URL.format(added_deposit.txid)} \n`);
        }
    } catch (e) {
        console.log("Cannot deposit!");
        console.log(e);
    }
}
// --------------------------------------- Main function -------------------------------------------------
async function main() {
    // Get data
    const [ CAKE_WBNB_Liquidity, CAKE_price, CAKE_WBNB_amount_in_usd, CAKE_pendingReward ] = await get_Pool_User_Info(pid_CAKE_BNB_LP, wallet.address, api_CAKE, api_WBNB);
    // Calculations
    const APR_CAKE_WBNB = calculateAPR(CAKE_WBNB_Liquidity, CAKE_price, farmMultiplier_CAKE_BNB);
    const [ execution, estimate_time_new, estimate_time_pending ] = await checkCompoundFrequency(APR_CAKE_WBNB, CAKE_WBNB_amount_in_usd, CAKE_pendingReward, CAKE_price);
    // Exexcute compounding
    if (execution == true) {
        const reward_CAKE = await depositRewardLP(pid_CAKE_BNB_LP, 0); // Harvest pending CAKE reward
        const [ amount_CAKE, amount_WBNB ] = await swapReward(addresses.CAKE, addresses.WBNB, reward_CAKE);
        const CAKE_WBNB_LP = await convertToLP(addresses.CAKE, addresses.WBNB, amount_CAKE, amount_WBNB);
        await depositRewardLP(pid_CAKE_BNB_LP, CAKE_WBNB_LP);
        console.log("Estimate time till compounding: ", estimate_time_new, "Hours\n");
        setTimeout(main, estimate_time_new * 60 * 60);
    } else { // Wait till optimal compounding time
        console.log("Estimate time till compounding: ", estimate_time_pending, "Hours\n");
        setTimeout(main, estimate_time_pending * 24 * 60);
    }
}

main()