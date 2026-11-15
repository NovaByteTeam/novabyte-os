NOTO_DEVANAGARI_VERSION = ffebf8c1ee449e544955a7e813c54f9b73848eac
NOTO_DEVANAGARI_SITE = https://raw.githubusercontent.com/googlefonts/noto-fonts/$(NOTO_DEVANAGARI_VERSION)/hinted/ttf/NotoSansDevanagari
NOTO_DEVANAGARI_SOURCE = NotoSansDevanagari-Regular.ttf
NOTO_DEVANAGARI_EXTRA_DOWNLOADS = \
	$(NOTO_DEVANAGARI_SITE)/NotoSansDevanagari-Bold.ttf \
	https://raw.githubusercontent.com/googlefonts/noto-fonts/$(NOTO_DEVANAGARI_VERSION)/LICENSE
NOTO_DEVANAGARI_LICENSE = OFL-1.1
NOTO_DEVANAGARI_LICENSE_FILES = LICENSE

define NOTO_DEVANAGARI_EXTRACT_CMDS
	mkdir -p $(@D)
	cp $(NOTO_DEVANAGARI_DL_DIR)/NotoSansDevanagari-Regular.ttf $(@D)/NotoSansDevanagari-Regular.ttf
	cp $(NOTO_DEVANAGARI_DL_DIR)/NotoSansDevanagari-Bold.ttf $(@D)/NotoSansDevanagari-Bold.ttf
	cp $(NOTO_DEVANAGARI_DL_DIR)/LICENSE $(@D)/LICENSE
endef

define NOTO_DEVANAGARI_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0644 $(@D)/NotoSansDevanagari-Regular.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf
	$(INSTALL) -D -m 0644 $(@D)/NotoSansDevanagari-Bold.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf
	$(INSTALL) -D -m 0644 $(@D)/LICENSE \
		$(TARGET_DIR)/usr/share/licenses/noto-devanagari/OFL.txt
endef

$(eval $(generic-package))
