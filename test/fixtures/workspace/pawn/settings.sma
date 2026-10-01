#include <amxmodx>
#include <menu_core>

public plugin_init()
{
	register_plugin("Settings", "1.0", "you");

	// Hides the knife for the player.
	mc_register_action("TOGGLE_HIDE_KNIFE", "OnHideKnife");
	mc_register_action( "INPUT_FOV" , "OnInputFov");
	// mc_register_action("GHOST", "OnGhost");
	/* mc_register_action("GHOST_TOO", "OnGhost"); */
	mc_register_placeholder("solo_status", "OnSoloStatus");
	mc_register_restriction("VIP", "OnVip", "Only for VIP");
	mc_create_menu("PAWN_MENU", "Pawn menu");
	new name[] = "LATE";
	mc_register_condition(name, "OnLate");
}
