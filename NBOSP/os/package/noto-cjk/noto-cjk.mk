NOTO_CJK_VERSION = f8d157532fbfaeda587e826d4cd5b21a49186f7c
NOTO_CJK_SITE = https://raw.githubusercontent.com/notofonts/noto-cjk/$(NOTO_CJK_VERSION)/Sans/SubsetOTF/SC
NOTO_CJK_SOURCE = NotoSansSC-Regular.otf
NOTO_CJK_EXTRA_DOWNLOADS = \
	https://raw.githubusercontent.com/notofonts/noto-cjk/$(NOTO_CJK_VERSION)/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf \
	https://raw.githubusercontent.com/notofonts/noto-cjk/$(NOTO_CJK_VERSION)/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf \
	https://raw.githubusercontent.com/notofonts/noto-cjk/$(NOTO_CJK_VERSION)/Sans/LICENSE
NOTO_CJK_LICENSE = OFL-1.1
NOTO_CJK_LICENSE_FILES = LICENSE

define NOTO_CJK_EXTRACT_CMDS
	mkdir -p $(@D)
	cp $(NOTO_CJK_DL_DIR)/NotoSansSC-Regular.otf $(@D)/NotoSansSC-Regular.otf
	cp $(NOTO_CJK_DL_DIR)/NotoSansJP-Regular.otf $(@D)/NotoSansJP-Regular.otf
	cp $(NOTO_CJK_DL_DIR)/NotoSansKR-Regular.otf $(@D)/NotoSansKR-Regular.otf
	cp $(NOTO_CJK_DL_DIR)/LICENSE $(@D)/LICENSE
endef

define NOTO_CJK_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0644 $(@D)/NotoSansSC-Regular.otf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf
	$(INSTALL) -D -m 0644 $(@D)/NotoSansJP-Regular.otf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansJP-Regular.otf
	$(INSTALL) -D -m 0644 $(@D)/NotoSansKR-Regular.otf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansKR-Regular.otf
	$(INSTALL) -D -m 0644 $(@D)/LICENSE \
		$(TARGET_DIR)/usr/share/licenses/noto-cjk/OFL.txt
endef

$(eval $(generic-package))
